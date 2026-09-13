import { defaultFetch, fetchLimits, type FetchLike } from './client.js';
import { normalizeLimits } from './normalize.js';
import { LimitsError, emptySnapshot, type LimitsErrorInfo, type LimitsSnapshot } from './types.js';

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Backoff cap, and the interval an expired token is parked at (§23.3). */
export const MAX_BACKOFF_MS = 600_000;
/** `POST /v1/refresh` is rate-limited to one per 10 s (§4). */
export const REFRESH_MIN_INTERVAL_MS = 10_000;

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
  }

  /** The current `/v1/limits` body. */
  snapshot(): LimitsSnapshot {
    return this.current;
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
    return this.current;
  }

  private fail(error: LimitsErrorInfo, bumpBackoff = true): LimitsSnapshot {
    if (bumpBackoff && !this.parked) this.failures += 1;
    this.log(`limits: fetch failed (${error.code}) — serving last-good, next poll in ${this.nextDelayMs}ms`);
    this.current = {
      ...this.current,
      stale: this.current.fetchedAt !== null,
      error,
    };
    return this.current;
  }
}
