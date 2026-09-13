import { isTokensGroupBy, type TokensGroupBy, type TokensQuery } from './types.js';

export const DEFAULT_SINCE = 'today';
export const DEFAULT_GROUP_BY: TokensGroupBy = 'project';

const RELATIVE = /^(\d+)([mhd])$/;

/** Local midnight for `since=today`, as an ISO-8601 `Z` instant. */
export function localMidnight(now: number): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * `since=<iso|7d|24h|today>` (§4). Returns an ISO-8601 `Z` instant, or `null` when the
 * value is not understood — the caller answers 400.
 */
export function parseSince(value: string | undefined, now: number = Date.now()): string | null {
  const raw = value === undefined || value.length === 0 ? DEFAULT_SINCE : value;
  if (raw === 'today') return localMidnight(now);
  if (raw === 'all') return new Date(0).toISOString();

  const rel = RELATIVE.exec(raw);
  if (rel !== null) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    if (!Number.isFinite(n)) return null;
    return new Date(now - n * ms).toISOString();
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export type TokensQueryResult = { ok: true; query: TokensQuery } | { ok: false; param: 'since' | 'groupBy' };

/** Validate `?since=&groupBy=` for `GET /v1/tokens`. */
export function parseTokensQuery(params: URLSearchParams, now: number = Date.now()): TokensQueryResult {
  const sinceRaw = params.get('since') ?? undefined;
  const since = parseSince(sinceRaw, now);
  if (since === null) return { ok: false, param: 'since' };

  const groupRaw = params.get('groupBy');
  if (groupRaw === null || groupRaw.length === 0) {
    return { ok: true, query: { since, groupBy: DEFAULT_GROUP_BY } };
  }
  // Multiple groupBy values are not supported in v1 (§4).
  if (params.getAll('groupBy').length > 1 || !isTokensGroupBy(groupRaw)) {
    return { ok: false, param: 'groupBy' };
  }
  return { ok: true, query: { since, groupBy: groupRaw } };
}
