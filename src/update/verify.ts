/**
 * sha256 verification of a downloaded tarball against the release's `SHA256SUMS` (§20).
 *
 * A mismatch deletes the download — an unverified tarball must never survive long
 * enough for anything else to pick it up — and reports `update.state: "error"`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { UpdateError } from './download.js';

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
  /** The name to look up in `SHA256SUMS`; defaults to the tarball's basename. */
  tarballFile?: string;
  /** Delete the tarball when it does not verify (default `true`). */
  deleteOnMismatch?: boolean;
}

/**
 * Verify the tarball. Returns the digest on success; throws `UpdateError` with code
 * `checksum_missing` or `checksum_mismatch` otherwise, having deleted the tarball.
 */
export async function verify(opts: VerifyOptions): Promise<string> {
  const file = opts.tarballFile ?? basename(opts.tarballPath);
  const drop = (): void => {
    if (opts.deleteOnMismatch !== false) rmSync(opts.tarballPath, { force: true });
  };

  let sums: Map<string, string>;
  try {
    sums = parseShasums(readFileSync(opts.shasumsPath, 'utf8'));
  } catch (err) {
    drop();
    throw new UpdateError('checksum_missing', `cannot read ${opts.shasumsPath}: ${(err as Error).message}`);
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
