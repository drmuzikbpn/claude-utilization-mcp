// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RELEASE_PUBLIC_KEY_PLACEHOLDER, TRUSTED_RELEASE_KEYS, type TrustedKey } from '../../src/update/trusted-keys.js';
import {
  digestsEqual,
  ED25519_SIGNATURE_BYTES,
  loadTrustedKey,
  parseShasums,
  parseSignature,
  sha256File,
  verifiedBy,
  verify,
  verifySignature,
} from '../../src/update/verify.js';
import { makeSigner, TempDirs } from './helpers.js';

const dirs = new TempDirs();
afterAll(() => {
  dirs.cleanup();
});

const TARBALL = 'claude-usage-0.1.418+abc.tgz';

/** §23.59: this file's own release key, generated in memory on every run. */
const SIGNER = makeSigner();

interface Fixture {
  tarballPath: string;
  shasumsPath: string;
  signaturePath: string;
  digest: string;
  /** Everything `verify()` needs, trusting this file's key. */
  opts: { tarballPath: string; shasumsPath: string; signaturePath: string; trustedKeys: TrustedKey[] };
}

/** A release on disk. `sig`: the signature body, or `null` for no file at all. */
function fixture(body = 'tarball-bytes', sums?: string, sig?: string | null): Fixture {
  const dir = dirs.make();
  const tarballPath = join(dir, TARBALL);
  const shasumsPath = join(dir, 'SHA256SUMS');
  const signaturePath = join(dir, 'SHA256SUMS.sig');
  writeFileSync(tarballPath, body);
  const digest = createHash('sha256').update(body).digest('hex');
  const sumsText = sums ?? `${digest}  ${TARBALL}\n`;
  writeFileSync(shasumsPath, sumsText);
  if (sig !== null) writeFileSync(signaturePath, sig ?? SIGNER.sign(sumsText));
  return { tarballPath, shasumsPath, signaturePath, digest, opts: { tarballPath, shasumsPath, signaturePath, trustedKeys: SIGNER.keys } };
}

describe('parseShasums', () => {
  it('reads the GNU coreutils format, the one-space and the binary-marker variants', () => {
    const sums = parseShasums(
      [
        `${'a'.repeat(64)}  claude-usage-1.0.0+a.tgz`,
        `${'b'.repeat(64)} SHA256SUMS`,
        `${'C'.repeat(64)}  *binary.tgz`,
        '',
        'garbage line',
        '# a comment',
      ].join('\n'),
    );
    expect(sums.get('claude-usage-1.0.0+a.tgz')).toBe('a'.repeat(64));
    expect(sums.get('SHA256SUMS')).toBe('b'.repeat(64));
    // Upper case is normalised, and a `*` binary marker is not part of the name.
    expect(sums.get('binary.tgz')).toBe('c'.repeat(64));
    expect(sums.size).toBe(3);
  });

  it('ignores any directory prefix on the filename', () => {
    expect(parseShasums(`${'a'.repeat(64)}  release/claude-usage-1.0.0+a.tgz`).get('claude-usage-1.0.0+a.tgz')).toBe('a'.repeat(64));
  });
});

describe('digestsEqual', () => {
  it('is case-insensitive, length-safe and correct', () => {
    expect(digestsEqual('a'.repeat(64), 'A'.repeat(64))).toBe(true);
    expect(digestsEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(digestsEqual('a'.repeat(64), 'a'.repeat(63))).toBe(false);
    expect(digestsEqual('', '')).toBe(true);
  });
});

describe('verify() (§20 "Integrity")', () => {
  it('accepts a signed, matching release and leaves the tarball in place', async () => {
    const f = fixture();
    await expect(verify({ ...f.opts, tarballFile: TARBALL })).resolves.toBe(f.digest);
    expect(existsSync(f.tarballPath)).toBe(true);
    expect(await sha256File(f.tarballPath)).toBe(f.digest);
  });

  it('deletes the download on a mismatch', async () => {
    const f = fixture('tarball-bytes', `${'0'.repeat(64)}  ${TARBALL}\n`);
    await expect(verify(f.opts)).rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('deletes the download when SHA256SUMS has no line for it', async () => {
    const f = fixture('tarball-bytes', `${'0'.repeat(64)}  some-other-file.tgz\n`);
    await expect(verify(f.opts)).rejects.toMatchObject({ code: 'checksum_missing' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('deletes the download when SHA256SUMS is missing entirely', async () => {
    const f = fixture();
    await expect(verify({ ...f.opts, shasumsPath: join(dirs.make(), 'nope') })).rejects.toMatchObject({ code: 'checksum_missing' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('can be told to keep the file (diagnostics)', async () => {
    const f = fixture('tarball-bytes', `${'0'.repeat(64)}  ${TARBALL}\n`);
    await expect(verify({ ...f.opts, deleteOnMismatch: false })).rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(existsSync(f.tarballPath)).toBe(true);
  });
});

describe('verify() — authenticity comes first (§23.59)', () => {
  it('refuses a release with no SHA256SUMS.sig, however correct its checksum, and deletes the download', async () => {
    const f = fixture('tarball-bytes', undefined, null);
    await expect(verify(f.opts)).rejects.toMatchObject({ name: 'UpdateError', code: 'signature_missing' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not base64', 'this is not a signature!\n'],
    ['base64 of the wrong length', `${Buffer.alloc(32).toString('base64')}\n`],
    ['base64 with trailing junk', `${Buffer.alloc(64).toString('base64')}AAAA\n`],
    ['two signatures', `${Buffer.alloc(64).toString('base64')}\n${Buffer.alloc(64).toString('base64')}\n`],
    ['enormous', `${'A'.repeat(4096)}\n`],
  ])('refuses a SHA256SUMS.sig that is %s', async (_label, sig) => {
    const f = fixture('tarball-bytes', undefined, sig);
    await expect(verify(f.opts)).rejects.toMatchObject({ code: 'signature_missing' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('refuses a well-formed signature made by a key we do not trust', async () => {
    const stranger = makeSigner('stranger');
    const f = fixture();
    writeFileSync(f.signaturePath, stranger.sign(readFileSync(f.shasumsPath)));
    await expect(verify(f.opts)).rejects.toMatchObject({ code: 'signature_invalid' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('refuses when SHA256SUMS was changed after signing — the attack the checksum alone cannot see', async () => {
    const f = fixture();
    // The attacker swaps the tarball and rewrites SHA256SUMS to match it. The old
    // signature no longer covers the file, and they cannot make a new one.
    writeFileSync(f.tarballPath, 'malicious-bytes');
    const evil = createHash('sha256').update('malicious-bytes').digest('hex');
    writeFileSync(f.shasumsPath, `${evil}  ${TARBALL}\n`);
    await expect(verify(f.opts)).rejects.toMatchObject({ code: 'signature_invalid' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('covers the exact bytes: one added newline is a different file', async () => {
    const f = fixture();
    writeFileSync(f.shasumsPath, `${readFileSync(f.shasumsPath, 'utf8')}\n`);
    await expect(verify(f.opts)).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('checks the signature before it believes any checksum: a bad signature wins over a bad digest', async () => {
    const stranger = makeSigner('stranger');
    const sums = `${'0'.repeat(64)}  ${TARBALL}\n`;
    const f = fixture('tarball-bytes', sums, stranger.sign(sums));
    await expect(verify(f.opts)).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('accepts a signature from any key on the list, so a key can be rotated', async () => {
    const retiring = makeSigner('old');
    const incoming = makeSigner('new');
    const trustedKeys = [...retiring.keys, ...incoming.keys];
    for (const signer of [retiring, incoming]) {
      const f = fixture();
      writeFileSync(f.signaturePath, signer.sign(readFileSync(f.shasumsPath)));
      await expect(verify({ ...f.opts, trustedKeys })).resolves.toBe(f.digest);
      expect(verifySignature({ shasumsPath: f.shasumsPath, signaturePath: f.signaturePath, trustedKeys }).keyId).toBe(signer.keys[0]?.id);
    }
    // Once the old key is dropped from the list, what it signed is refused.
    const f = fixture();
    writeFileSync(f.signaturePath, retiring.sign(readFileSync(f.shasumsPath)));
    await expect(verify({ ...f.opts, trustedKeys: incoming.keys })).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('skips an unusable entry rather than failing on it', async () => {
    const f = fixture();
    const trustedKeys: TrustedKey[] = [{ id: 'junk', publicKey: 'AAAA' }, { id: 'placeholder', publicKey: RELEASE_PUBLIC_KEY_PLACEHOLDER }, ...SIGNER.keys];
    await expect(verify({ ...f.opts, trustedKeys })).resolves.toBe(f.digest);
  });

  it.each([
    ['an empty list', []],
    ['only the placeholder', [{ id: 'p', publicKey: RELEASE_PUBLIC_KEY_PLACEHOLDER }]],
    ['only garbage', [{ id: 'g', publicKey: 'not base64 at all' }, { id: 'h', publicKey: '' }]],
  ] as Array<[string, TrustedKey[]]>)('fails closed with %s: nothing can be verified, so nothing is installed', async (_label, trustedKeys) => {
    const f = fixture();
    await expect(verify({ ...f.opts, trustedKeys })).rejects.toMatchObject({ code: 'no_trusted_keys' });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('only an Ed25519 key counts: an RSA or P-256 public key on the list is not usable', () => {
    for (const pair of [generateKeyPairSync('rsa', { modulusLength: 2048 }), generateKeyPairSync('ec', { namedCurve: 'prime256v1' })]) {
      const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      expect(loadTrustedKey({ id: 'other', publicKey })).toBeNull();
    }
    expect(loadTrustedKey(SIGNER.keys[0] as TrustedKey)?.asymmetricKeyType).toBe('ed25519');
  });

  it('parseSignature takes strict base64 of exactly 64 bytes', () => {
    const good = Buffer.alloc(ED25519_SIGNATURE_BYTES, 7).toString('base64');
    expect(parseSignature(`${good}\n`)?.byteLength).toBe(64);
    expect(parseSignature(`  ${good}  `)?.byteLength).toBe(64);
    expect(parseSignature(good.slice(0, -2))).toBeNull();
    expect(parseSignature(`${good.slice(0, 10)} ${good.slice(10)}`)).toBeNull();
    expect(parseSignature(`-${good.slice(1)}`)).toBeNull();
  });
});

describe('the compiled-in release keys (§23.59)', () => {
  it('the list is never empty', () => {
    expect(TRUSTED_RELEASE_KEYS.length).toBeGreaterThan(0);
    for (const key of TRUSTED_RELEASE_KEYS) {
      expect(key.id.length).toBeGreaterThan(0);
      expect(key.publicKey.length).toBeGreaterThan(0);
    }
  });

  it('every entry is either a usable Ed25519 key or the one marked placeholder', () => {
    for (const key of TRUSTED_RELEASE_KEYS) {
      if (key.publicKey === RELEASE_PUBLIC_KEY_PLACEHOLDER) continue;
      expect(loadTrustedKey(key), key.id).not.toBeNull();
    }
    expect(TRUSTED_RELEASE_KEYS.filter((k) => k.publicKey === RELEASE_PUBLIC_KEY_PLACEHOLDER).length).toBeLessThanOrEqual(1);
  });

  it('the placeholder can never verify anything', () => {
    const placeholder: TrustedKey[] = [{ id: 'placeholder', publicKey: RELEASE_PUBLIC_KEY_PLACEHOLDER }];
    expect(loadTrustedKey(placeholder[0] as TrustedKey)).toBeNull();
    const data = Buffer.from('anything');
    expect(verifiedBy(data, Buffer.from(SIGNER.sign(data).trim(), 'base64'), placeholder)).toBeNull();
    expect(verifiedBy(data, Buffer.alloc(64), placeholder)).toBeNull();
  });

  it('with the list as shipped, an update signed by anyone else is refused', async () => {
    const f = fixture();
    const shipped = { tarballPath: f.tarballPath, shasumsPath: f.shasumsPath, signaturePath: f.signaturePath };
    await expect(verify(shipped)).rejects.toMatchObject({ code: expect.stringMatching(/^(no_trusted_keys|signature_invalid)$/) as string });
    expect(existsSync(f.tarballPath)).toBe(false);
  });
});
