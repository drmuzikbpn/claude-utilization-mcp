export type LimitsErrorCode = 'unauthorized' | 'network' | 'schema_drift' | 'no_credentials' | 'rate_limited';

export interface LimitsErrorInfo {
  code: LimitsErrorCode;
  message: string;
  hint?: string;
  /** `rate_limited` only: when upstream said to try again (ISO 8601), if it said (§23.32). */
  retryAt?: string;
}

/** Error thrown by `fetchLimits`. Never carries token material. */
export class LimitsError extends Error {
  readonly code: LimitsErrorCode;
  readonly hint: string | undefined;
  readonly status: number | undefined;
  /** `rate_limited` only: upstream's `Retry-After`, in ms, when it sent a usable one. */
  readonly retryAfterMs: number | undefined;
  constructor(
    code: LimitsErrorCode,
    message: string,
    opts: { hint?: string; status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'LimitsError';
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  toInfo(): LimitsErrorInfo {
    return this.hint === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, hint: this.hint };
  }
}

export interface LimitScope {
  model: string | null;
  surface: string | null;
}

/** One entry of upstream `limits[]`, normalized 1:1 (§23.3). */
export interface NormalizedLimit {
  id: string;
  kind: string;
  group: string | null;
  percent: number | null;
  severity: string | null;
  resetsAt: string | null;
  scope: LimitScope | null;
  isActive: boolean;
}

export interface LegacyWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface ExtraUsage {
  isEnabled: boolean | null;
  utilization: number | null;
  spendLimitReached: boolean | null;
}

export interface NormalizedLimits {
  limits: NormalizedLimit[];
  /** Best-effort passthrough of `five_hour` / `seven_day` only. */
  legacyWindows: Record<string, LegacyWindow>;
  extraUsage: ExtraUsage | null;
}

/** The `/v1/limits` response body. */
export interface LimitsSnapshot extends NormalizedLimits {
  fetchedAt: string | null;
  stale: boolean;
  error: LimitsErrorInfo | null;
  raw: unknown;
}

/** `/v1/limits` minus `raw`, as embedded in `/v1/summary` (§4). */
export type LimitsSnapshotLite = Omit<LimitsSnapshot, 'raw'>;

export function stripRaw(snapshot: LimitsSnapshot): LimitsSnapshotLite {
  return {
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
    error: snapshot.error,
    limits: snapshot.limits,
    legacyWindows: snapshot.legacyWindows,
    extraUsage: snapshot.extraUsage,
  };
}

export function emptySnapshot(error: LimitsErrorInfo | null = null): LimitsSnapshot {
  return {
    fetchedAt: null,
    stale: false,
    error,
    limits: [],
    legacyWindows: {},
    extraUsage: null,
    raw: null,
  };
}
