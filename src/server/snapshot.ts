/**
 * The response bodies of `/health`, `/v1/limits` and `/v1/summary`, as pure functions.
 *
 * They live here — rather than inline in `createServer` — because `GET /v1/events`
 * (§19) must embed byte-for-byte the same bodies in its `snapshot` event. Shape logic
 * exists exactly once; the route handlers and the SSE snapshot both call these.
 */
import type { Config, Thresholds } from '../config.js';
import { computeStatus, type StatusReport } from '../limits/status.js';
import { stripRaw, type LimitsSnapshot, type LimitsSnapshotLite } from '../limits/types.js';
import type { OauthAccount } from './identity.js';
import { emptyScanStats, zeroTotals, type TokenTotals, type TokensSource } from './types.js';

/**
 * Everything the bodies read. Deliberately structural: a `LimitsProvider` and the
 * server's own closure state both satisfy it without importing either.
 */
export interface SnapshotDeps {
  config: Config;
  limits: { snapshot(): LimitsSnapshot };
  /** Live getter — the token store is attached after the HTTP server starts (§6). */
  tokens(): TokensSource | null;
  /** Cached `~/.claude.json → oauthAccount` reader (§15). */
  user(): OauthAccount | null;
  version: string;
  startedAt: number;
  now(): number;
}

/** `/health.update`, also the payload of the SSE `update` event (§15, §19, §20). */
export interface UpdateStatus {
  channel: string;
  current: string;
  available: string | null;
  state: 'idle' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'deferred' | 'disabled';
  deferredReason: string | null;
}

export interface TodayTotals extends TokenTotals {
  ready: boolean;
}

export interface SummaryBody {
  limits: LimitsSnapshotLite;
  status: StatusReport;
  thresholds: Thresholds;
  today: TodayTotals;
}

/** W8 owns auto-update; until then the daemon reports it as disabled. */
export function updateBody(version: string): UpdateStatus {
  return {
    channel: 'stable',
    current: version,
    available: null,
    state: 'disabled',
    deferredReason: null,
  };
}

export function healthBody(d: SnapshotDeps): Record<string, unknown> {
  const tokens = d.tokens();
  const stats = tokens?.stats ?? emptyScanStats();
  return {
    ok: true,
    name: d.config.name,
    version: d.version,
    uptimeMs: Math.max(0, d.now() - d.startedAt),
    pid: process.pid,
    user: d.user(),
    update: updateBody(d.version),
    stats: {
      filesTracked: stats.filesTracked,
      eventsIndexed: stats.eventsIndexed,
      parseErrors: stats.parseErrors,
      lastScanAt: stats.lastScanAt,
      spendReady: tokens?.ready ?? false,
      ...(stats.scan === undefined ? {} : { scan: stats.scan }),
    },
  };
}

/** The `/v1/limits` body. */
export function limitsBody(d: SnapshotDeps): LimitsSnapshot {
  return d.limits.snapshot();
}

/** `/v1/limits` minus `raw` — what `/v1/summary` embeds and what SSE sends (§4, §19). */
export function limitsLiteBody(d: Pick<SnapshotDeps, 'limits'>): LimitsSnapshotLite {
  return stripRaw(d.limits.snapshot());
}

/** UTC midnight, the lower bound of "today" for `/v1/summary.today` (aggregates are UTC-day keyed, §23.7). */
export function startOfDayIso(now: number): string {
  return new Date(new Date(now).setUTCHours(0, 0, 0, 0)).toISOString();
}

/** Machine-wide totals since local midnight; also the `today` of the SSE `spend` event. */
export function todayBody(d: Pick<SnapshotDeps, 'tokens' | 'now'>): TodayTotals {
  const tokens = d.tokens();
  const ready = tokens?.ready ?? false;
  const totals = ready && tokens !== null
    ? tokens.query({ since: startOfDayIso(d.now()), groupBy: 'day' }).totals
    : zeroTotals();
  return { ready, ...totals };
}

export function summaryBody(d: SnapshotDeps): SummaryBody {
  const snapshot = d.limits.snapshot();
  return {
    // `/v1/limits` minus `raw` (§4); the array itself is §23.3's shape.
    limits: stripRaw(snapshot),
    status: computeStatus(snapshot.limits, d.config.thresholds),
    thresholds: d.config.thresholds,
    today: todayBody(d),
  };
}
