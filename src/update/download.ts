/**
 * Fetch a release's tarball and `SHA256SUMS` into a throwaway directory (§20).
 *
 * Two hard rules, both enforced here rather than at the call site: the URL must be
 * `https:` (no plaintext, no `file:` smuggled in through a redirect-free asset URL),
 * and nothing over 50 MB is ever written to disk.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import { SHASUMS_NAME, tarballName } from './version.js';
import { defaultUpdateFetch, type ReleaseInfo, type UpdateFetch, type UpdateRequestInit } from './check.js';

/** Anything bigger is a mistake or an attack; the real tarball is ~100 kB. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** A download that never happened, with a machine-readable reason. */
export class UpdateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

/** `<XDG_DATA_HOME>/claude-usage/tmp` — scratch space beside the versions layout. */
export function tmpRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'tmp');
}

/** Create (and return) a fresh `<data>/claude-usage/tmp/update-XXXXXX` directory, 0700. */
export function makeTempDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = tmpRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, 'update-'));
}

export interface DownloadOptions {
  fetch?: UpdateFetch;
  currentVersion: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

interface BodyResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Throws unless the URL parses and uses `https:` — TLS only (§20 "Integrity"). */
export function assertHttps(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpdateError('insecure_url', `refusing to download a malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new UpdateError('insecure_url', `refusing to download over ${parsed.protocol} — https only (${url})`);
  }
  return parsed;
}

/**
 * Download one asset to `dest`. `content-length` is honoured before the body is read,
 * and the body is measured again afterwards in case the header lied.
 */
export async function downloadTo(url: string, dest: string, opts: DownloadOptions): Promise<number> {
  assertHttps(url);
  const max = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const fetchImpl = (opts.fetch ?? defaultUpdateFetch()) as unknown as (
    u: string,
    init?: UpdateRequestInit,
  ) => Promise<BodyResponse>;

  const init: UpdateRequestInit = {
    method: 'GET',
    headers: { accept: 'application/octet-stream', 'user-agent': `claude-usage/${opts.currentVersion}` },
    redirect: 'follow',
  };
  if (opts.signal !== undefined) init.signal = opts.signal;
  else init.signal = AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);

  let res: BodyResponse;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new UpdateError('network', `downloading ${url} failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new UpdateError('http', `downloading ${url} returned HTTP ${String(res.status)}`);

  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    throw new UpdateError('too_large', `${url} declares ${String(declared)} bytes, over the ${String(max)} byte cap`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > max) {
    throw new UpdateError('too_large', `${url} sent ${String(buf.byteLength)} bytes, over the ${String(max)} byte cap`);
  }
  writeFileSync(dest, buf, { mode: 0o600 });
  return buf.byteLength;
}

export interface DownloadedRelease {
  dir: string;
  tarballPath: string;
  shasumsPath: string;
  /** The tarball's filename — the key `SHA256SUMS` is looked up under. */
  tarballFile: string;
  bytes: number;
}

/** Download both assets of a release into a fresh temp directory. Cleans up on failure. */
export async function download(
  release: ReleaseInfo,
  opts: DownloadOptions & { env?: NodeJS.ProcessEnv; dir?: string },
): Promise<DownloadedRelease> {
  const dir = opts.dir ?? makeTempDir(opts.env ?? process.env);
  const tarballFile = tarballName(release.version);
  const tarballPath = join(dir, tarballFile);
  const shasumsPath = join(dir, SHASUMS_NAME);
  try {
    const bytes = await downloadTo(release.tarballUrl, tarballPath, opts);
    await downloadTo(release.shasumsUrl, shasumsPath, opts);
    return { dir, tarballPath, shasumsPath, tarballFile, bytes };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
