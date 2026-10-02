import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { buildSelfSignedCert, derToPem, encodeLength, encodeOid, spkiFingerprint } from '../../src/net/x509.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tls');

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** The contract's openssl pipeline: cert → SPKI DER → SHA-256. */
function opensslFingerprint(certDer: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'cu-x509-'));
  const file = join(dir, 'c.der');
  writeFileSync(file, certDer);
  const pubPem = execFileSync('openssl', ['x509', '-inform', 'der', '-in', file, '-pubkey', '-noout']);
  const spki = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pubPem });
  return createHash('sha256').update(spki).digest('hex');
}

function issue(over: Partial<Parameters<typeof buildSelfSignedCert>[0]> = {}): { der: Buffer; fp: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = buildSelfSignedCert({
    privateKey,
    publicKey,
    commonName: 'claude-usage studio',
    dnsNames: ['localhost', 'studio.local'],
    ipAddresses: ['127.0.0.1'],
    notBefore: new Date('2026-10-01T00:00:00Z'),
    notAfter: new Date('2029-01-03T00:00:00Z'),
    ...over,
  });
  return { der, fp: spkiFingerprint(publicKey) };
}

describe('DER primitives', () => {
  it('encodes short and long lengths', () => {
    expect(encodeLength(5).toString('hex')).toBe('05');
    expect(encodeLength(127).toString('hex')).toBe('7f');
    expect(encodeLength(128).toString('hex')).toBe('8180');
    expect(encodeLength(300).toString('hex')).toBe('82012c');
  });

  it('encodes OIDs, including multi-byte arcs', () => {
    // ecdsa-with-SHA256
    expect(encodeOid('1.2.840.10045.4.3.2').toString('hex')).toBe('06082a8648ce3d040302');
    expect(encodeOid('2.5.29.17').toString('hex')).toBe('0603551d11');
  });
});

describe('buildSelfSignedCert (§23.45)', () => {
  it('round-trips through crypto.X509Certificate with the pinned SPKI fingerprint', () => {
    const { der, fp } = issue();
    const x = new X509Certificate(der);
    expect(x.subject).toContain('CN=claude-usage studio');
    expect(x.issuer).toBe(x.subject);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    expect(x.checkHost('studio.local')).toBe('studio.local');
    expect(x.checkHost('localhost')).toBe('localhost');
    expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(x.keyUsage).toContain('1.3.6.1.5.5.7.3.1'); // serverAuth
    expect(new Date(x.validFrom).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(new Date(x.validTo).toISOString()).toBe('2029-01-03T00:00:00.000Z');
    expect(spkiFingerprint(x.publicKey)).toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('starts every SPKI with the P-256 header the iOS app prepends (B1)', () => {
    const { der } = issue();
    const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' });
    expect(spki.subarray(0, 26).toString('hex')).toBe('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    expect(spki.length).toBe(26 + 65);
  });

  it('uses GeneralizedTime past 2049', () => {
    const { der } = issue({ notAfter: new Date('2051-06-01T12:00:00Z') });
    expect(new Date(new X509Certificate(der).validTo).toISOString()).toBe('2051-06-01T12:00:00.000Z');
  });

  it('serves a real TLS handshake whose peer key matches the fingerprint', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = buildSelfSignedCert({
      privateKey,
      publicKey,
      commonName: 'claude-usage test',
      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1'],
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
    });
    const server: Server = createServer(
      { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: derToPem(der, 'CERTIFICATE') },
      (_req, res) => res.end('ok'),
    );
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    try {
      const peer = await new Promise<Buffer>((resolve, reject) => {
        const socket = connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
          const raw = socket.getPeerCertificate().raw;
          socket.end();
          resolve(raw);
        });
        socket.on('error', reject);
      });
      expect(spkiFingerprint(new X509Certificate(peer).publicKey)).toBe(spkiFingerprint(publicKey));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(!hasOpenssl())('agrees with openssl on parsing and on the fingerprint', () => {
    const { der, fp } = issue();
    expect(opensslFingerprint(der)).toBe(fp);
  });
});

describe('shared fixture test/fixtures/tls (consumed by the iOS pinning tests)', () => {
  const der = readFileSync(join(FIXTURES, 'cert.der'));
  const expected = readFileSync(join(FIXTURES, 'fingerprint.txt'), 'utf8').trim();

  it('has the recorded SPKI fingerprint', () => {
    const x = new X509Certificate(der);
    expect(spkiFingerprint(x.publicKey)).toBe(expected);
    expect(x.verify(x.publicKey)).toBe(true);
  });

  it.skipIf(!hasOpenssl())('openssl computes the same fingerprint', () => {
    expect(opensslFingerprint(der)).toBe(expected);
  });
});
