// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Verification of a downloaded release (§20, §23.59), in this order:
 *
 * 1. **authenticity** — `SHA256SUMS.sig` must be an Ed25519 signature over the exact bytes
 *    of `SHA256SUMS`, by one of the keys compiled into `trusted-keys.ts`;
 * 2. **integrity** — the tarball must hash to the digest that now-trusted file names.
 *
 * Nothing is believed before step 1 passes: not a checksum, not a file name. Any failure
 * deletes the download — an unverified tarball must never survive long enough for
 * anything else to pick it up — and reports `update.state: "error"`. It fails closed: no
 * signature, no usable key, an unreadable file all mean "not installed".
 */
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { createReadStream, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { UpdateError } from './download.js';
import { TRUSTED_RELEASE_KEYS, type TrustedKey } from './trusted-keys.js';

/** An Ed25519 signature is exactly this long. */
export const ED25519_SIGNATURE_BYTES = 64;
/** `SHA256SUMS.sig` is one base64 line; anything much larger is not one. */
export const MAX_SIGNATURE_FILE_BYTES = 1_024;

/** The key as a `KeyObject`, or `null` when the entry is not a usable Ed25519 public key. */
export function loadTrustedKey(key: TrustedKey): KeyObject | null {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key.publicKey)) return null;
    const object = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
    return object.asymmetricKeyType === 'ed25519' ? object : null;
  } catch {
    return null;
  }
}

/** Decode the body of a `.sig` file: strict base64 of exactly 64 bytes, else `null`. */
export function parseSignature(text: string): Buffer | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const sig = Buffer.from(trimmed, 'base64');
  // Round-trip, so non-canonical or truncated base64 is not quietly accepted.
  if (sig.toString('base64') !== trimmed) return null;
  return sig.byteLength === ED25519_SIGNATURE_BYTES ? sig : null;
}

/**
 * Is `signature` a valid signature over `data` by any of `keys`? Returns the id of the key
 * that verified it, or `null`. Unusable entries are skipped, never fatal.
 */
export function verifiedBy(data: Buffer, signature: Buffer, keys: readonly TrustedKey[]): string | null {
  for (const key of keys) {
    const object = loadTrustedKey(key);
    if (object === null) continue;
    try {
      if (cryptoVerify(null, data, object, signature)) return key.id;
    } catch {
      // a key the runtime cannot use — try the next
    }
  }
  return null;
}

export interface SignatureOptions {
  shasumsPath: string;
  signaturePath: string;
  /** Defaults to the compiled-in list; injected in tests, which generate their own keys. */
  trustedKeys?: readonly TrustedKey[];
}

/**
 * Check `SHA256SUMS` against `SHA256SUMS.sig`. Returns the verified bytes of `SHA256SUMS`
 * and the id of the key that signed them; throws `UpdateError` with code
 * `signature_missing` (no file, or not a signature), `no_trusted_keys` (nothing compiled
 * in can verify anything) or `signature_invalid` (a signature, but not ours).
 */
export function verifySignature(opts: SignatureOptions): { sums: Buffer; keyId: string } {
  const keys = opts.trustedKeys ?? TRUSTED_RELEASE_KEYS;
  if (!keys.some((k) => loadTrustedKey(k) !== null)) {
    throw new UpdateError('no_trusted_keys', 'this build has no usable release key compiled in — it cannot verify any update');
  }

  let sums: Buffer;
  try {
    sums = readFileSync(opts.shasumsPath);
  } catch (err) {
    throw new UpdateError('checksum_missing', `cannot read ${opts.shasumsPath}: ${(err as Error).message}`);
  }
  let raw: Buffer;
  try {
    raw = readFileSync(opts.signaturePath);
  } catch (err) {
    throw new UpdateError('signature_missing', `the release has no readable SHA256SUMS.sig: ${(err as Error).message}`);
  }
  const signature = raw.byteLength > MAX_SIGNATURE_FILE_BYTES ? null : parseSignature(raw.toString('utf8'));
  if (signature === null) {
    throw new UpdateError('signature_missing', 'SHA256SUMS.sig is not a base64 Ed25519 signature');
  }
  const keyId = verifiedBy(sums, signature, keys);
  if (keyId === null) {
    throw new UpdateError('signature_invalid', 'SHA256SUMS is not signed by a trusted release key — the download was deleted');
  }
  return { sums, keyId };
}

/** `<64 hex>  <filename>` (GNU coreutils; one space and a `*` binary marker are tolerated). */
const LINE_RE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;

/** Parse a `SHA256SUMS` body into `filename → lowercase hex digest`. */
export function parseShasums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line.trim());
    if (m === null) continue;
    const [, digest, name] = m as unknown as [string, string, string];
    out.set(basename(name.trim()), digest.toLowerCase());
  }
  return out;
}

/** sha256 of a file, streamed so a 50 MB tarball never doubles up in memory. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** Constant-time hex comparison; different lengths are unequal without leaking where. */
export function digestsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a.toLowerCase(), 'utf8');
  const bb = Buffer.from(b.toLowerCase(), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface VerifyOptions {
  tarballPath: string;
  shasumsPath: string;
  /** `SHA256SUMS.sig` (§23.59). Required: there is no unsigned path. */
  signaturePath: string;
  /** Defaults to the compiled-in list; injected in tests, which generate their own keys. */
  trustedKeys?: readonly TrustedKey[];
  /** The name to look up in `SHA256SUMS`; defaults to the tarball's basename. */
  tarballFile?: string;
  /** Delete the tarball when it does not verify (default `true`). */
  deleteOnMismatch?: boolean;
}

/**
 * Verify the release. Returns the tarball's digest on success; throws `UpdateError` with
 * code `signature_missing`, `signature_invalid`, `no_trusted_keys`, `checksum_missing` or
 * `checksum_mismatch` otherwise, having deleted the tarball.
 */
export async function verify(opts: VerifyOptions): Promise<string> {
  const file = opts.tarballFile ?? basename(opts.tarballPath);
  const drop = (): void => {
    if (opts.deleteOnMismatch !== false) rmSync(opts.tarballPath, { force: true });
  };

  // Authenticity first (§23.59). The checksums are parsed from the very bytes the
  // signature covered, not re-read from disk, so there is no window to swap the file.
  let sums: Map<string, string>;
  try {
    const signed = verifySignature({
      shasumsPath: opts.shasumsPath,
      signaturePath: opts.signaturePath,
      ...(opts.trustedKeys === undefined ? {} : { trustedKeys: opts.trustedKeys }),
    });
    sums = parseShasums(signed.sums.toString('utf8'));
  } catch (err) {
    drop();
    throw err;
  }

  const expected = sums.get(file);
  if (expected === undefined) {
    drop();
    throw new UpdateError('checksum_missing', `SHA256SUMS has no line for ${file}`);
  }

  let actual: string;
  try {
    actual = await sha256File(opts.tarballPath);
  } catch (err) {
    drop();
    throw new UpdateError('checksum_missing', `cannot hash ${opts.tarballPath}: ${(err as Error).message}`);
  }

  if (!digestsEqual(actual, expected)) {
    drop();
    throw new UpdateError('checksum_mismatch', `sha256 mismatch for ${file} — the download was deleted`);
  }
  return actual;
}
