import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../config.js';
import { defaultFetch, fetchLimits, type FetchLike } from './client.js';
import { normalizeLimits } from './normalize.js';
import { LimitsError, emptySnapshot, type LimitsErrorInfo, type LimitsSnapshot } from './types.js';

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Backoff cap, and the interval an expired token is parked at (§23.3). */
export const MAX_BACKOFF_MS = 600_000;
/** `POST /v1/refresh` is rate-limited to one per 10 s (§4). */
export const REFRESH_MIN_INTERVAL_MS = 10_000;
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
  return {
    ...base,
    fetchedAt,
    stale: true,
    error: null,
    limits: rec['limits'] as LimitsSnapshot['limits'],
    legacyWindows: (rec['legacyWindows'] as LimitsSnapshot['legacyWindows']) ?? base.legacyWindows,
    extraUsage: (rec['extraUsage'] as LimitsSnapshot['extraUsage']) ?? base.extraUsage,
  };
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
  private lastRefreshAt: number | null = null;
  private readonly configDir: string | null;
  private readonly listeners = new Set<() => void>();
  private lastSignature: string = snapshotSignature(emptySnapshot());

  constructor(opts: PollerOptions) {
    this.getToken = opts.getToken;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.refreshMinIntervalMs = opts.refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS;
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
    if (this.parked) return this.maxBackoffMs;
    if (this.failures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * 2 ** this.failures, this.maxBackoffMs);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin polling; performs an immediate fetch, then schedules by `nextDelayMs`. */
  start(): void {
    if (this.running) return;
    this.running = true;
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
    if (this.lastRefreshAt !== null && now - this.lastRefreshAt < this.refreshMinIntervalMs) {
      return { rateLimited: true, snapshot: this.current };
    }
    this.lastRefreshAt = now;
    const snapshot = await this.tick();
    return { rateLimited: false, snapshot };
  }

  private async tick(): Promise<LimitsSnapshot> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.fetchOnce().finally(() => {
      this.inFlight = null;
      this.reschedule();
    });
    this.inFlight = run;
    return run;
  }

  private reschedule(): void {
    if (!this.running) return;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      void this.tick();
    }, this.nextDelayMs);
  }

  private async fetchOnce(): Promise<LimitsSnapshot> {
    let token: string;
    try {
      token = await this.getToken();
    } catch (err) {
      return this.fail(toErrorInfo(err));
    }

    try {
      return this.succeed(await this.fetchLimitsImpl(token, this.fetchImpl));
    } catch (err) {
      if (!(err instanceof LimitsError) || err.code !== 'unauthorized') {
        return this.fail(toErrorInfo(err));
      }
      // 401: Claude Code may have rotated the token under us. Re-read credentials once.
      this.log('limits: 401 — re-reading credentials once');
      try {
        const fresh = await this.getToken({ fresh: true });
        return this.succeed(await this.fetchLimitsImpl(fresh, this.fetchImpl));
      } catch (retryErr) {
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
      });
    } catch {
      // best effort
    }
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
