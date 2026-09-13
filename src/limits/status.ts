import type { Thresholds } from '../config.js';
import type { NormalizedLimit } from './types.js';

export type LimitStatus = 'ok' | 'warn' | 'critical';

export interface StatusReport {
  byId: Record<string, LimitStatus>;
  overall: LimitStatus;
}

/**
 * Upstream severity strings we treat as critical-like. Anything else that is not
 * `normal` escalates to `warn`; unknown strings are never thrown on (§23.3).
 */
export const CRITICAL_SEVERITIES: ReadonlySet<string> = new Set([
  'critical',
  'severe',
  'exceeded',
  'exhausted',
  'blocked',
  'locked',
  'limit_reached',
  'over_limit',
]);

export const NORMAL_SEVERITY = 'normal';

const RANK: Record<LimitStatus, number> = { ok: 0, warn: 1, critical: 2 };

export function worstStatus(a: LimitStatus, b: LimitStatus): LimitStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Status for a single limit (§23.3):
 * - `critical` if `percent >= critical` **or** severity is critical-like
 * - `warn` if `percent >= warn` **or** `severity !== "normal"`
 * - else `ok`
 */
export function limitStatus(limit: NormalizedLimit, thresholds: Thresholds): LimitStatus {
  const severity = limit.severity;
  const percent = limit.percent;
  const severityLower = severity === null ? null : severity.toLowerCase();

  if ((percent !== null && percent >= thresholds.critical) || (severityLower !== null && CRITICAL_SEVERITIES.has(severityLower))) {
    return 'critical';
  }
  if ((percent !== null && percent >= thresholds.warn) || (severityLower !== null && severityLower !== NORMAL_SEVERITY)) {
    return 'warn';
  }
  return 'ok';
}

/** `{ byId, overall }` for `/v1/summary.status`. */
export function computeStatus(limits: readonly NormalizedLimit[], thresholds: Thresholds): StatusReport {
  const byId: Record<string, LimitStatus> = {};
  let overall: LimitStatus = 'ok';
  for (const limit of limits) {
    const status = limitStatus(limit, thresholds);
    byId[limit.id] = status;
    overall = worstStatus(overall, status);
  }
  return { byId, overall };
}
