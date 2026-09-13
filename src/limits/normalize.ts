import type { ExtraUsage, LegacyWindow, LimitScope, NormalizedLimit, NormalizedLimits } from './types.js';

/** Only these two legacy windows are promised (§23.3); everything else lives in `raw`. */
export const LEGACY_WINDOW_KEYS = ['five_hour', 'seven_day'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `percent` is the upstream integer; thresholds are evaluated on it alone (§23.3). */
function asPercent(v: unknown): number | null {
  const n = asNumber(v);
  return n === null ? null : Math.round(n);
}

/** Normalize a timestamp through `Date` to ISO-8601 `Z`. May legitimately be `null`. */
export function toIsoZ(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeScope(v: unknown): LimitScope | null {
  if (!isRecord(v)) return null;
  const modelRaw = v['model'];
  const model = isRecord(modelRaw) ? asString(modelRaw['display_name']) : asString(modelRaw);
  const surfaceRaw = v['surface'];
  const surface = isRecord(surfaceRaw) ? asString(surfaceRaw['display_name']) : asString(surfaceRaw);
  if (model === null && surface === null) return { model: null, surface: null };
  return { model, surface };
}

/** `id` = `kind` + (`:` + lower-cased `scope.model.display_name` when present). */
export function limitId(kind: string, scope: LimitScope | null): string {
  const model = scope?.model;
  return model !== null && model !== undefined && model.length > 0 ? `${kind}:${model.toLowerCase()}` : kind;
}

function normalizeLimitEntry(entry: unknown): NormalizedLimit | null {
  if (!isRecord(entry)) return null;
  const kind = asString(entry['kind']);
  if (kind === null) return null;
  const scope = normalizeScope(entry['scope']);
  const id = limitId(kind, scope);
  return {
    id,
    kind,
    group: asString(entry['group']),
    percent: asPercent(entry['percent']),
    // Unknown severity strings pass through untouched — never thrown on (§23.3).
    severity: asString(entry['severity']),
    resetsAt: toIsoZ(entry['resets_at']),
    scope,
    isActive: entry['is_active'] === true,
  };
}

function normalizeLegacyWindows(raw: Record<string, unknown>): Record<string, LegacyWindow> {
  const out: Record<string, LegacyWindow> = {};
  for (const key of LEGACY_WINDOW_KEYS) {
    const v = raw[key];
    if (!isRecord(v)) continue;
    out[key] = { utilization: asNumber(v['utilization']), resetsAt: toIsoZ(v['resets_at']) };
  }
  return out;
}

function normalizeExtraUsage(raw: Record<string, unknown>): ExtraUsage | null {
  const v = raw['extra_usage'];
  if (!isRecord(v)) return null;
  return {
    isEnabled: asBool(v['is_enabled']),
    utilization: asNumber(v['utilization']),
    spendLimitReached: asBool(v['spend_limit_reached']),
  };
}

/**
 * Normalize the upstream `GET /api/oauth/usage` payload (§23.3).
 *
 * `limits[]` is the only authoritative model and is mapped 1:1. Unknown top-level keys
 * (including unreleased windows such as `unknown_window_example`) are ignored — `raw`
 * keeps everything. Never throws.
 */
export function normalizeLimits(payload: unknown): NormalizedLimits {
  if (!isRecord(payload)) {
    return { limits: [], legacyWindows: {}, extraUsage: null };
  }
  const limitsRaw = payload['limits'];
  const limits: NormalizedLimit[] = [];
  if (Array.isArray(limitsRaw)) {
    for (const entry of limitsRaw) {
      const normalized = normalizeLimitEntry(entry);
      if (normalized !== null) limits.push(normalized);
    }
  }
  return {
    limits,
    legacyWindows: normalizeLegacyWindows(payload),
    extraUsage: normalizeExtraUsage(payload),
  };
}
