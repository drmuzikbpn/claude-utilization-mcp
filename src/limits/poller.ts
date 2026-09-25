import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../config.js';
import { defaultFetch, fetchLimits, type FetchLike } from './client.js';
import { normalizeLimits } from './normalize.js';
import {
  LimitsError,
  emptySnapshot,
  type LimitsErrorInfo,
  type LimitsSnapshot,
  type NormalizedLimit,
} from './types.js';

/**
 * The usage endpoint's budget is unpublished, and 60 s polling from one machine was enough
 * to earn a 429 with a 50-minute Retry-After (§23.33). Limits move slowly; five minutes is
 * plenty for a dashboard, and the floor below holds for configs written with the old default.
 */
export const DEFAULT_POLL_INTERVAL_MS = 300_000;
/** No configured interval polls faster than this (§23.33). */
export const MIN_POLL_INTERVAL_MS = 120_000;
/** Each upstream 429 doubles the effective interval, up to this (§23.33). */
export const MAX_ADAPTIVE_INTERVAL_MS = 1_800_000;
/** Consecutive successful polls before a slowed-down interval is halved again (§23.33). */
export const RELAX_AFTER_SUCCESSES = 12;
/** Backoff cap, and the interval an expired token is parked at (§23.3). */
export const MAX_BACKOFF_MS = 600_000;
/**
 * `POST /v1/refresh` is served from cache when upstream was called less than this long ago —
 * by a refresh *or* a scheduled poll (§4, amended by §23.33).
 */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

/** `config.pollIntervalMs` as the poller will actually use it (§23.33). */
export function effectivePollIntervalMs(configured: number): number {
  return Math.max(configured, MIN_POLL_INTERVAL_MS);
}
/**
 * Ceiling on an upstream `Retry-After` (§23.32). Upstream has asked for ~50 min; a value in
 * days is more likely a parse or clock problem than an instruction, and the daemon must not
 * go quiet for that long on the strength of one header.
 */
export const MAX_RETRY_AFTER_MS = 6 * 3_600_000;
/** Where the last good snapshot survives a restart (§23.19). */
export const LIMITS_CACHE_FILE = 'limits-cache.json';

export const LIMITS_CACHE_VERSION = 1;

export function limitsCachePath(configDir: string): string {
  return join(configDir, LIMITS_CACHE_FILE);
}

/**
 * The last good snapshot from a previous process, or `null`.
 *
 * Deliberately **not** including `raw`: the cache exists so a freshly restarted daemon can
 * answer with real percentages, and the upstream payload is neither needed for that nor
 * something to leave lying on disk.
 */
export function readCachedSnapshot(configDir: string): LimitsSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(limitsCachePath(configDir), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['version'] !== LIMITS_CACHE_VERSION) return null;
  if (!Array.isArray(rec['limits'])) return null;
  const fetchedAt = typeof rec['fetchedAt'] === 'string' ? rec['fetchedAt'] : null;
  if (fetchedAt === null) return null;
  const base = emptySnapshot();
  // Validate field by field rather than casting. This file is ours and 0600, but it is the
  // one input that flows straight into `/v1/summary` — and from there to a dashboard — with
  // no upstream call to sanity-check it. A half-written or hand-edited entry must degrade
  // to "no cache", never to a limit with a NaN percent.
  const limits: NormalizedLimit[] = [];
  for (const entry of rec['limits'] as unknown[]) {
    const limit = coerceLimit(entry);
    if (limit === null) return null;
    limits.push(limit);
  }
  if (limits.length === 0) return null;
  return {
    ...base,
    fetchedAt,
    stale: true,
    error: null,
    limits,
    legacyWindows: coerceLegacyWindows(rec['legacyWindows']),
    extraUsage: (rec['extraUsage'] as LimitsSnapshot['extraUsage']) ?? base.extraUsage,
  };
}

/**
 * The end of an upstream 429 window a previous process was told about, or `null` (§23.32).
 * Read separately from the snapshot so a 429 before any successful fetch still survives.
 */
export function readCachedRateLimitedUntil(configDir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(limitsCachePath(configDir), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = (parsed as Record<string, unknown>)['rateLimitedUntil'];
    if (typeof raw !== 'string') return null;
    const at = Date.parse(raw);
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

/** The `error` a caller sees while upstream is rate-limiting us (§23.32). */
export function rateLimitedInfo(retryAt: number | null): LimitsErrorInfo {
  const base = 'Anthropic is rate-limiting the usage endpoint (HTTP 429)';
  const hint =
    'nothing to fix locally — the daemon retries on its own; percentages are from the last successful fetch (see fetchedAt)';
  if (retryAt === null) return { code: 'rate_limited', message: base, hint };
  const iso = new Date(retryAt).toISOString();
  return { code: 'rate_limited', message: `${base}; next attempt after ${iso}`, hint, retryAt: iso };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A cached limit, or `null` when it is not one. `percent` must be a real number or absent. */
function coerceLimit(value: unknown): NormalizedLimit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || rec['id'].length === 0) return null;
  if (typeof rec['kind'] !== 'string') return null;
  const percent = rec['percent'];
  if (percent !== null && percent !== undefined && (typeof percent !== 'number' || !Number.isFinite(percent))) {
    return null;
  }
  return {
    id: rec['id'],
    kind: rec['kind'],
    group: optionalString(rec['group']),
    percent: typeof percent === 'number' ? percent : null,
    severity: optionalString(rec['severity']),
    resetsAt: optionalString(rec['resetsAt']),
    scope: (rec['scope'] as NormalizedLimit['scope']) ?? null,
    isActive: rec['isActive'] === true,
  };
}

/** Drops any window that is not `{ utilization: number|null, resetsAt: string|null }`. */
function coerceLegacyWindows(value: unknown): LimitsSnapshot['legacyWindows'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: LimitsSnapshot['legacyWindows'] = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const win = raw as Record<string, unknown>;
    const utilization = win['utilization'];
    if (utilization !== null && (typeof utilization !== 'number' || !Number.isFinite(utilization))) continue;
    out[key] = { utilization: typeof utilization === 'number' ? utilization : null, resetsAt: optionalString(win['resetsAt']) };
  }
  return out;
}

export interface Timers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realTimers: Timers = {
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    if (typeof t === 'object' && t !== null && typeof t.unref === 'function') t.unref();
    return t;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type TokenReader = (opts?: { fresh?: boolean }) => Promise<string>;

export interface PollerOptions {
  getToken: TokenReader;
  intervalMs?: number;
  maxBackoffMs?: number;
  refreshMinIntervalMs?: number;
  fetchImpl?: FetchLike;
  /** Override the whole fetch step (tests). */
  fetchLimitsImpl?: (token: string, fetchImpl: FetchLike) => Promise<unknown>;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Config dir to persist the last good snapshot in, so a restart serves numbers instead
   * of an empty list (§23.19). Omitted (tests, one-shot CLI reads) disables the cache.
   */
  configDir?: string | null;
}

/**
 * Change signature of a snapshot for `onChange` (§19).
 *
 * `fetchedAt` and `raw` are deliberately excluded: a poll that re-fetched the same numbers
 * is not news, and waking every SSE client once a minute to say so would defeat the point.
 */
export function snapshotSignature(snapshot: LimitsSnapshot): string {
  return JSON.stringify([
    snapshot.stale,
    snapshot.error === null ? null : [snapshot.error.code, snapshot.error.message],
    snapshot.limits.map((l) => [l.id, l.kind, l.group, l.percent, l.severity, l.resetsAt, l.isActive]),
    snapshot.legacyWindows,
    snapshot.extraUsage,
  ]);
}

function toErrorInfo(err: unknown): LimitsErrorInfo {
  if (err instanceof LimitsError) return err.toInfo();
  const code = (err as { code?: unknown }).code;
  if (code === 'no_credentials' || code === 'unsupported_platform') {
    const hint = (err as { hint?: unknown }).hint;
    const info: LimitsErrorInfo = { code: 'no_credentials', message: (err as Error).message };
    return typeof hint === 'string' ? { ...info, hint } : info;
  }
  return { code: 'network', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Polls `GET /api/oauth/usage` and keeps the last good value (§5.2, §23.3).
 *
 * Failures serve the last good snapshot with `stale: true` and an `error`; the interval
 * doubles from the base up to 10 min. A 401 re-reads credentials once and retries; if it
 * is still 401 the interval parks at 10 min until a fetch succeeds.
 */
export class LimitsPoller {
  readonly intervalMs: number;
  readonly maxBackoffMs: number;
  readonly refreshMinIntervalMs: number;

  private readonly getToken: TokenReader;
  private readonly fetchImpl: FetchLike;
  private readonly fetchLimitsImpl: (token: string, fetchImpl: FetchLike) => Promise<unknown>;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private current: LimitsSnapshot = emptySnapshot();
  private failures = 0;
  private parked = false;
  private handle: unknown = null;
  private running = false;
  private inFlight: Promise<LimitsSnapshot> | null = null;
  /** When upstream was last called, by a poll or a refresh (§23.33). */
  private lastAttemptAt: number | null = null;
  /** Poll interval after 429-driven slow-downs; never below `intervalMs` (§23.33). */
  private adaptiveIntervalMs: number;
  private successStreak = 0;
  /** Epoch ms before which upstream asked not to be called again (§23.32). */
  private rateLimitedUntil: number | null = null;
  private readonly configDir: string | null;
  private readonly listeners = new Set<() => void>();
  private lastSignature: string = snapshotSignature(emptySnapshot());

  constructor(opts: PollerOptions) {
    this.getToken = opts.getToken;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.refreshMinIntervalMs = opts.refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS;
    this.adaptiveIntervalMs = this.intervalMs;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch();
    this.fetchLimitsImpl = opts.fetchLimitsImpl ?? ((token, f) => fetchLimits(token, f));
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.configDir = opts.configDir ?? null;
    const restored = this.configDir === null ? null : readCachedSnapshot(this.configDir);
    if (restored !== null) {
      // Marked stale on purpose: these numbers predate this process, and every consumer
      // already knows to treat `stale` as "believe it, but it may have moved".
      this.current = restored;
      this.lastSignature = snapshotSignature(restored);
    }
    // §23.32: a restart (routine, with auto-update) must not re-poll inside a 429 window a
    // previous process was given — say so from the first request instead.
    const until = this.configDir === null ? null : readCachedRateLimitedUntil(this.configDir);
    if (until !== null && until > this.now()) {
      this.rateLimitedUntil = until;
      this.current = { ...this.current, error: rateLimitedInfo(until) };
      this.lastSignature = snapshotSignature(this.current);
    }
  }

  /** The current `/v1/limits` body. */
  snapshot(): LimitsSnapshot {
    return this.current;
  }

  /**
   * Subscribe to changes: fires after any poll — successful or failed — whose body
   * differs from the last one (§19). Returns an unsubscribe function.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Called once per completed poll, after `this.current` has been replaced. */
  private notifyIfChanged(): void {
    const signature = snapshotSignature(this.current);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        // A subscriber must never break polling.
        this.log(`limits: onChange listener threw — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Delay until the next scheduled poll, reflecting backoff. */
  get nextDelayMs(): number {
    const blocked = this.blockedForMs();
    const base = this.adaptiveIntervalMs;
    if (this.parked) return Math.max(this.maxBackoffMs, blocked);
    if (this.failures === 0) return Math.max(base, blocked);
    return Math.max(Math.min(this.intervalMs * 2 ** this.failures, this.maxBackoffMs), base, blocked);
  }

  /** How much of upstream's 429 window is left, in ms; 0 when none (§23.32). */
  private blockedForMs(): number {
    if (this.rateLimitedUntil === null) return 0;
    return Math.max(0, this.rateLimitedUntil - this.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin polling; performs an immediate fetch, then schedules by `nextDelayMs`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.blockedForMs() > 0) {
      this.reschedule();
      return;
    }
    // §23.33: a restart (routine, with auto-update) whose cached numbers are younger than
    // the interval has nothing to gain from calling upstream now.
    const fetchedAt = this.current.fetchedAt === null ? NaN : Date.parse(this.current.fetchedAt);
    const age = this.now() - fetchedAt;
    if (age >= 0 && age < this.adaptiveIntervalMs) {
      this.scheduleIn(this.adaptiveIntervalMs - age);
      return;
    }
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  /** Forced refetch for `POST /v1/refresh`; one per `refreshMinIntervalMs`. */
  async refresh(): Promise<{ rateLimited: boolean; snapshot: LimitsSnapshot }> {
    const now = this.now();
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.refreshMinIntervalMs) {
      return { rateLimited: true, snapshot: this.current };
    }
    // §23.32: inside an upstream 429 window a forced refetch would only extend it. Answer
    // with the current snapshot, whose error already says until when.
    if (this.blockedForMs() > 0) return { rateLimited: false, snapshot: this.current };
    // Fresh token read: an explicit refresh is the escape hatch from a previous account's
    // still-valid credential (§23.31), and reusing the cached one would defeat it. A refresh
    // that lands on top of an in-flight scheduled poll joins that poll instead — one interval
    // late, not wrong.
    const snapshot = await this.tick(true);
    return { rateLimited: false, snapshot };
  }

  private async tick(freshToken = false): Promise<LimitsSnapshot> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.fetchOnce(freshToken).finally(() => {
      this.inFlight = null;
      this.reschedule();
    });
    this.inFlight = run;
    return run;
  }

  private reschedule(): void {
    this.scheduleIn(this.nextDelayMs);
  }

  private scheduleIn(ms: number): void {
    if (!this.running) return;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      void this.tick();
    }, ms);
  }

  private async fetchOnce(freshToken = false): Promise<LimitsSnapshot> {
    let token: string;
    try {
      token = await this.getToken(freshToken ? { fresh: true } : undefined);
    } catch (err) {
      return this.fail(toErrorInfo(err));
    }

    this.lastAttemptAt = this.now();
    try {
      return this.succeed(await this.fetchLimitsImpl(token, this.fetchImpl));
    } catch (err) {
      if (isRateLimited(err)) return this.rateLimited(err);
      if (!(err instanceof LimitsError) || err.code !== 'unauthorized') {
        return this.fail(toErrorInfo(err));
      }
      // 401: Claude Code may have rotated the token under us. Re-read credentials once.
      this.log('limits: 401 — re-reading credentials once');
      try {
        const fresh = await this.getToken({ fresh: true });
        return this.succeed(await this.fetchLimitsImpl(fresh, this.fetchImpl));
      } catch (retryErr) {
        if (isRateLimited(retryErr)) return this.rateLimited(retryErr);
        const info = toErrorInfo(retryErr);
        if (info.code === 'unauthorized') {
          // Still 401 — park at 10 min rather than hammer an expired token.
          this.parked = true;
          return this.fail(info, false);
        }
        return this.fail(info);
      }
    }
  }

  private succeed(payload: unknown): LimitsSnapshot {
    const normalized = normalizeLimits(payload);
    this.failures = 0;
    this.parked = false;
    this.rateLimitedUntil = null;
    this.successStreak += 1;
    if (this.successStreak >= RELAX_AFTER_SUCCESSES && this.adaptiveIntervalMs > this.intervalMs) {
      this.adaptiveIntervalMs = Math.max(this.intervalMs, Math.floor(this.adaptiveIntervalMs / 2));
      this.successStreak = 0;
    }
    this.current = {
      fetchedAt: new Date(this.now()).toISOString(),
      stale: false,
      error: null,
      ...normalized,
      raw: payload,
    };
    this.writeCache();
    this.notifyIfChanged();
    return this.current;
  }

  /**
   * Persist the last good numbers. Best effort and never on the hot path of a response:
   * a snapshot we cannot write is a slightly worse restart, not a failed poll.
   */
  private writeCache(): void {
    if (this.configDir === null) return;
    try {
      writeJsonFile(limitsCachePath(this.configDir), {
        version: LIMITS_CACHE_VERSION,
        fetchedAt: this.current.fetchedAt,
        limits: this.current.limits,
        legacyWindows: this.current.legacyWindows,
        extraUsage: this.current.extraUsage,
        ...(this.rateLimitedUntil === null ? {} : { rateLimitedUntil: new Date(this.rateLimitedUntil).toISOString() }),
      });
    } catch {
      // best effort
    }
  }

  /**
   * Upstream 429 (§23.32): back off as for any failure, but never retry before its
   * `Retry-After` (capped at `MAX_RETRY_AFTER_MS`), and persist that so a restart doesn't.
   */
  private rateLimited(err: LimitsError): LimitsSnapshot {
    // The budget is unpublished, so learn it: every 429 halves our rate (§23.33).
    this.adaptiveIntervalMs = Math.min(Math.max(this.adaptiveIntervalMs * 2, this.intervalMs), MAX_ADAPTIVE_INTERVAL_MS);
    this.successStreak = 0;
    const after = err.retryAfterMs;
    this.rateLimitedUntil = after === undefined ? null : this.now() + Math.min(after, MAX_RETRY_AFTER_MS);
    const snapshot = this.fail(rateLimitedInfo(this.rateLimitedUntil));
    this.writeCache();
    return snapshot;
  }

  private fail(error: LimitsErrorInfo, bumpBackoff = true): LimitsSnapshot {
    if (bumpBackoff && !this.parked) this.failures += 1;
    this.log(`limits: fetch failed (${error.code}) — serving last-good, next poll in ${this.nextDelayMs}ms`);
    this.current = {
      ...this.current,
      stale: this.current.fetchedAt !== null,
      error,
    };
    this.notifyIfChanged();
    return this.current;
  }
}

function isRateLimited(err: unknown): err is LimitsError {
  return err instanceof LimitsError && err.code === 'rate_limited';
}
