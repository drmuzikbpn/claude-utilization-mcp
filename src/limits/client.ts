import { LimitsError } from './types.js';

export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
/** Literal beta header Claude Code sends (§23.3, fixture README). */
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: RequestInitLike) => Promise<HttpResponseLike>;

export function defaultFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike;
}

export interface FetchLimitsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * `GET https://api.anthropic.com/api/oauth/usage` (§5.2, §23.3).
 *
 * The only Anthropic endpoint this project ever calls, and it is read-only: we never
 * refresh tokens. Returns the verbatim payload; throws `LimitsError` on failure.
 */
export async function fetchLimits(
  token: string,
  fetchImpl: FetchLike = defaultFetch(),
  opts: FetchLimitsOptions = {},
): Promise<unknown> {
  const init: RequestInitLike = {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      accept: 'application/json',
    },
  };
  if (opts.signal !== undefined) init.signal = opts.signal;
  else if (opts.timeoutMs !== undefined) init.signal = AbortSignal.timeout(opts.timeoutMs);

  let res: HttpResponseLike;
  try {
    res = await fetchImpl(USAGE_ENDPOINT, init);
  } catch (err) {
    throw new LimitsError('network', `usage request failed: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new LimitsError('unauthorized', `usage request rejected with ${res.status}`, {
      hint: 'run `claude` to re-login',
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new LimitsError('network', `usage request returned HTTP ${res.status}`, { status: res.status });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new LimitsError('network', `could not read usage response: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LimitsError('schema_drift', 'usage response was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LimitsError('schema_drift', 'usage response was not a JSON object');
  }
  if (!Array.isArray((parsed as { limits?: unknown }).limits)) {
    throw new LimitsError('schema_drift', 'usage response has no "limits" array');
  }
  return parsed;
}
