/**
 * `GET https://api.github.com/repos/<repo>/releases/latest` (§20).
 *
 * Unauthenticated on purpose: no GitHub token is ever read, logged or embedded. The
 * anonymous limit is 60 requests/hour per IP and the loop asks 6 times an hour, so the
 * conditional request (`If-None-Match`) is politeness rather than necessity.
 */
import { SHASUMS_NAME, tarballName } from './version.js';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const CHECK_TIMEOUT_MS = 10_000;

export interface HeadersLike {
  get(name: string): string | null;
}

export interface UpdateResponseLike {
  ok: boolean;
  status: number;
  headers: HeadersLike;
  text(): Promise<string>;
}

export interface UpdateRequestInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  redirect?: 'follow';
}

export type UpdateFetch = (url: string, init?: UpdateRequestInit) => Promise<UpdateResponseLike>;

export function defaultUpdateFetch(): UpdateFetch {
  return globalThis.fetch as unknown as UpdateFetch;
}

/** Everything `download()` needs about a release. */
export interface ReleaseInfo {
  version: string;
  tarballUrl: string;
  shasumsUrl: string;
}

export interface CheckOptions {
  repo: string;
  /** Sent as `User-Agent: claude-usage/<version>` — GitHub rejects requests without one. */
  currentVersion: string;
  fetch?: UpdateFetch;
  /** Previous `ETag`; a matching release answers 304 and we re-use the cached result. */
  etag?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CheckResult {
  /** `null` for 304, 404, a network error or a malformed/asset-less release. */
  release: ReleaseInfo | null;
  /** The response `ETag`, to feed back in as `opts.etag`; `null` when absent. */
  etag: string | null;
  /** The release did not change since `opts.etag`. */
  notModified: boolean;
  /** Short reason the release is `null`; `null` on success. */
  error: string | null;
}

export function releasesLatestUrl(repo: string, origin = GITHUB_API_ORIGIN): string {
  return `${origin}/repos/${repo}/releases/latest`;
}

/** Release-tag prefixes owned by other artifacts in this repo (§23.17). */
export const FOREIGN_TAG_PREFIXES = ['deck-'] as const;

/** Does `tag` belong to something other than the daemon? Case-insensitive. */
export function isForeignTag(tag: string): boolean {
  const lower = tag.toLowerCase();
  return FOREIGN_TAG_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function userAgent(version: string): string {
  return `claude-usage/${version}`;
}

function assetUrl(assets: unknown, name: string): string | null {
  if (!Array.isArray(assets)) return null;
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue;
    const a = asset as { name?: unknown; browser_download_url?: unknown };
    if (a.name === name && typeof a.browser_download_url === 'string') return a.browser_download_url;
  }
  return null;
}

/**
 * Ask GitHub for the newest release. Never throws: every failure comes back as
 * `release: null` plus a short `error`, because a check that fails must not take the
 * daemon down.
 */
export async function check(opts: CheckOptions): Promise<CheckResult> {
  const fetchImpl = opts.fetch ?? defaultUpdateFetch();
  const url = releasesLatestUrl(opts.repo);
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': userAgent(opts.currentVersion),
    'x-github-api-version': '2022-11-28',
  };
  if (typeof opts.etag === 'string' && opts.etag.length > 0) headers['if-none-match'] = opts.etag;

  const init: UpdateRequestInit = { method: 'GET', headers };
  if (opts.signal !== undefined) init.signal = opts.signal;
  else init.signal = AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS);

  let res: UpdateResponseLike;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    return { release: null, etag: opts.etag ?? null, notModified: false, error: `network: ${(err as Error).message}` };
  }

  const etag = res.headers.get('etag');
  if (res.status === 304) {
    return { release: null, etag: etag ?? opts.etag ?? null, notModified: true, error: null };
  }
  if (!res.ok) {
    return { release: null, etag: opts.etag ?? null, notModified: false, error: `http ${String(res.status)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    return { release: null, etag, notModified: false, error: 'malformed: response was not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { release: null, etag, notModified: false, error: 'malformed: response was not an object' };
  }

  const body = parsed as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (body.draft === true || body.prerelease === true) {
    return { release: null, etag, notModified: false, error: 'malformed: release is a draft or prerelease' };
  }
  if (typeof body.tag_name !== 'string' || body.tag_name.length === 0) {
    return { release: null, etag, notModified: false, error: 'malformed: release has no tag_name' };
  }
  // The Android dashboard ships its APK from this same repo under `deck-*` tags, published
  // so they never become "latest". If one ever does, it is not ours and not an error: report
  // "nothing available" rather than poisoning the update state with a malformed-release
  // message that would also hide the next real daemon release.
  if (isForeignTag(body.tag_name)) {
    return { release: null, etag, notModified: false, error: null };
  }
  const version = body.tag_name.replace(/^v/, '');
  const tarballUrl = assetUrl(body.assets, tarballName(version));
  const shasumsUrl = assetUrl(body.assets, SHASUMS_NAME);
  if (tarballUrl === null || shasumsUrl === null) {
    return {
      release: null,
      etag,
      notModified: false,
      error: `malformed: release ${body.tag_name} is missing ${tarballUrl === null ? tarballName(version) : SHASUMS_NAME}`,
    };
  }

  return { release: { version, tarballUrl, shasumsUrl }, etag, notModified: false, error: null };
}
