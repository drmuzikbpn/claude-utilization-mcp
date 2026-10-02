/**
 * The daemon's TLS identity (§23.45): one ECDSA P-256 key, generated once and kept, and a
 * self-signed certificate for it. Clients pin the key's SPKI hash, so the key is the
 * identity; the certificate is re-issued with the same key whenever it is near expiry,
 * unreadable, or does not match — and the pin survives.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureConfigDir, writeFileAtomic } from '../config.js';
import { buildSelfSignedCert, derToPem, spkiFingerprint } from './x509.js';

export const TLS_KEY_FILE = 'tls-key.pem';
export const TLS_CERT_FILE = 'tls-cert.pem';
/** Apple's ceiling for a TLS server certificate. */
export const CERT_VALIDITY_DAYS = 825;
export const REISSUE_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;

export interface TlsIdentity {
  /** PEM, for `https.createServer`. Never logged. */
  key: string;
  cert: string;
  /** Lowercase hex SHA-256 of the SPKI DER — the pin. */
  fingerprint: string;
  /** A new key was generated (paired apps must re-pair). */
  created: boolean;
  /** The certificate was re-issued for the existing key. */
  reissued: boolean;
}

export interface TlsIdentityOptions {
  configDir: string;
  /** `config.name`, for the certificate's CN. */
  name: string;
  /** `<LocalHostName>.local`, added to the SAN when known. */
  localHostName?: string | null;
  now?: () => number;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function usableCert(pem: string | null, publicKey: KeyObject, now: number): boolean {
  if (pem === null) return false;
  try {
    const x = new X509Certificate(pem);
    if (spkiFingerprint(x.publicKey) !== spkiFingerprint(publicKey)) return false;
    return Date.parse(x.validTo) - now > REISSUE_WITHIN_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

/** Load the identity from the config directory, creating or re-issuing what is missing. */
export function loadOrCreateTlsIdentity(opts: TlsIdentityOptions): TlsIdentity {
  const now = (opts.now ?? Date.now)();
  ensureConfigDir(opts.configDir);
  const keyFile = join(opts.configDir, TLS_KEY_FILE);
  const certFile = join(opts.configDir, TLS_CERT_FILE);

  let keyPem = readText(keyFile);
  let privateKey: KeyObject | null = null;
  if (keyPem !== null) {
    try {
      privateKey = createPrivateKey(keyPem);
    } catch {
      privateKey = null;
    }
  }
  const created = privateKey === null;
  if (privateKey === null) {
    privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    writeFileAtomic(keyFile, keyPem, 0o600);
  }
  const publicKey = createPublicKey(privateKey);

  let certPem = readText(certFile);
  const reissue = created || !usableCert(certPem, publicKey, now);
  if (reissue) {
    const der = buildSelfSignedCert({
      privateKey,
      publicKey,
      commonName: `claude-usage ${opts.name}`.slice(0, 64),
      dnsNames: ['localhost', ...(opts.localHostName ? [opts.localHostName] : [])],
      ipAddresses: ['127.0.0.1'],
      notBefore: new Date(now - DAY_MS), // tolerate a phone whose clock is a little behind
      notAfter: new Date(now + CERT_VALIDITY_DAYS * DAY_MS - DAY_MS),
    });
    certPem = derToPem(der, 'CERTIFICATE');
    writeFileAtomic(certFile, certPem, 0o600);
  }

  return {
    key: keyPem as string,
    cert: certPem as string,
    fingerprint: spkiFingerprint(publicKey),
    created,
    reissued: reissue && !created,
  };
}

/** The pin of the stored certificate, or `null` when there is none (CLI use). Never throws. */
export function readTlsFingerprint(configDir: string): string | null {
  const pem = readText(join(configDir, TLS_CERT_FILE));
  if (pem === null) return null;
  try {
    return spkiFingerprint(new X509Certificate(pem));
  } catch {
    return null;
  }
}
