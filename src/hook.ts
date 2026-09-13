import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from './clients/http.js';
import { resolveConfigDir, writeJsonFile } from './config.js';
import type { LimitStatus } from './limits/status.js';
import type { NormalizedLimit } from './limits/types.js';

/** §7.1: the hook's own internal HTTP deadline (the registered hook timeout is seconds — §23.11). */
export const HOOK_DEADLINE_MS = 200;
export const HOOK_STATE_FILE = 'hook-state.json';
export const DEFAULT_DEBOUNCE_MINUTES = 10;

/** The `session` limit is the 5 h window; `weekly_all` is the 7 d window (§23.3). */
export const HEADLINE_IDS = ['session', 'weekly_all'] as const;

const LABELS: Record<string, string> = { session: '5h window', weekly_all: '7d window' };
const SHORT_LABELS: Record<string, string> = { session: '5h', weekly_all: '7d' };

export interface HookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

export interface SummaryLimits {
  limits: NormalizedLimit[];
}

export interface SummaryBody {
  limits: SummaryLimits;
  status: { byId: Record<string, LimitStatus>; overall: LimitStatus };
  thresholds: { warn: number; critical: number };
  today?: Record<string, unknown>;
}

export interface HookState {
  lastKey: string | null;
  lastStatus: LimitStatus | null;
  lastPrintedAt: number | null;
}

export interface HookIO {
  /** Raw stdin JSON; the hook reads and tolerates anything. */
  stdin?: string;
  stdout?: (text: string) => void;
  configDir?: string;
  client?: Pick<DaemonClient, 'get'>;
  now?: () => number;
  deadlineMs?: number;
  debounceMinutes?: number;
}

export function parseHookStdin(text: string | undefined): HookStdin {
  if (text === undefined || text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as HookStdin;
  } catch {
    // Stdin is advisory; a malformed payload must never break the session.
  }
  return {};
}

export function hookStatePath(configDir: string = resolveConfigDir()): string {
  return join(configDir, HOOK_STATE_FILE);
}

export function readHookState(configDir: string): HookState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(hookStatePath(configDir), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      return {
        lastKey: typeof rec['lastKey'] === 'string' ? rec['lastKey'] : null,
        lastStatus: typeof rec['lastStatus'] === 'string' ? (rec['lastStatus'] as LimitStatus) : null,
        lastPrintedAt: typeof rec['lastPrintedAt'] === 'number' ? rec['lastPrintedAt'] : null,
      };
    }
  } catch {
    // No state yet, or unreadable — treat as "nothing printed".
  }
  return { lastKey: null, lastStatus: null, lastPrintedAt: null };
}

export function writeHookState(configDir: string, state: HookState): void {
  try {
    writeJsonFile(hookStatePath(configDir), state);
  } catch {
    // The hook must never fail because of its own bookkeeping.
  }
}

function findLimit(limits: readonly NormalizedLimit[], id: string): NormalizedLimit | undefined {
  return limits.find((l) => l.id === id);
}

const RANK: Record<LimitStatus, number> = { ok: 0, warn: 1, critical: 2 };

/** The limit the message leads with: the worst of `session` / `weekly_all`, session on a tie. */
export function pickHeadline(
  limits: readonly NormalizedLimit[],
  byId: Record<string, LimitStatus>,
): { limit: NormalizedLimit; status: LimitStatus } | null {
  let best: { limit: NormalizedLimit; status: LimitStatus } | null = null;
  for (const id of HEADLINE_IDS) {
    const limit = findLimit(limits, id);
    if (limit === undefined) continue;
    const status = byId[id] ?? 'ok';
    if (best === null || RANK[status] > RANK[best.status]) best = { limit, status };
  }
  return best;
}

/** `resets 14:35`, or `resets: unknown` when upstream gave us no timestamp (§23.3). */
export function formatResetsAt(resetsAt: string | null): string {
  if (resetsAt === null) return 'resets: unknown';
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return 'resets: unknown';
  const d = new Date(ms);
  return `resets ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `resets in 41m` / `resets in 2h 05m`, or `resets: unknown`. */
export function formatResetsIn(resetsAt: string | null, now: number): string {
  if (resetsAt === null) return 'resets: unknown';
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return 'resets: unknown';
  const minutes = Math.max(0, Math.round((ms - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes}m`;
  const h = Math.floor(minutes / 60);
  return `resets in ${h}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function pct(limit: NormalizedLimit): string {
  return limit.percent === null ? '?%' : `${limit.percent}%`;
}

/** The §7.1 nudge line, or `null` when `overall === "ok"`. */
export function formatNudge(summary: SummaryBody, now: number): string | null {
  const overall = summary.status.overall;
  if (overall === 'ok') return null;
  const limits = summary.limits.limits;
  const headline = pickHeadline(limits, summary.status.byId);
  if (headline === null) return null;

  const label = LABELS[headline.limit.id] ?? headline.limit.id;

  if (overall === 'critical') {
    return `🛑 Claude usage: ${label} ${pct(headline.limit)} — ${formatResetsIn(headline.limit.resetsAt, now)}. Defer non-urgent work; keep outputs short.`;
  }

  const parts: string[] = [];
  for (const id of HEADLINE_IDS) {
    const limit = findLimit(limits, id);
    if (limit === undefined) continue;
    const short = SHORT_LABELS[id] ?? id;
    parts.push(
      id === headline.limit.id
        ? `${LABELS[id] ?? id} ${pct(limit)} (${formatResetsAt(limit.resetsAt)})`
        : `${short} ${pct(limit)}`,
    );
  }
  if (parts.length === 0) return null;
  return `⚠ Claude usage: ${parts.join(', ')}. Prefer lighter work, smaller models, avoid large file reads.`;
}

function isSummary(v: unknown): v is SummaryBody {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  const limits = rec['limits'];
  const status = rec['status'];
  if (typeof limits !== 'object' || limits === null) return false;
  if (!Array.isArray((limits as { limits?: unknown }).limits)) return false;
  if (typeof status !== 'object' || status === null) return false;
  return typeof (status as { overall?: unknown }).overall === 'string';
}

/**
 * `claude-usage hook` (§7.1). Any failure prints nothing; the exit code is always 0
 * so a hook can never slow or break a session.
 */
export async function runHook(io: HookIO = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text));
  const now = io.now ?? Date.now;
  const configDir = io.configDir ?? resolveConfigDir();

  try {
    // `session_id`, `cwd` and `transcript_path` are read here; W3 uses them.
    const input = parseHookStdin(io.stdin);
    void input;

    // ---- W3 extension point -------------------------------------------------
    // The soft-pause gate and the SessionStart/heartbeat calls hang off this hook
    // (§17.1, §18.2). They run BEFORE the nudge and may block on their own
    // (86 400 s registered timeout, §23.11); the nudge below keeps its own 200 ms
    // deadline regardless. Add them here, guarded so a failure still exits 0.
    // -------------------------------------------------------------------------

    const client = io.client ?? new DaemonClient({ configDir, timeoutMs: io.deadlineMs ?? HOOK_DEADLINE_MS });
    const body = await client.get('/v1/summary', { timeoutMs: io.deadlineMs ?? HOOK_DEADLINE_MS });
    if (!isSummary(body)) return 0;

    const line = formatNudge(body, now());
    if (line === null) return 0;

    const headline = pickHeadline(body.limits.limits, body.status.byId);
    const key = `${headline?.limit.id ?? 'overall'}:${body.status.overall}`;
    const state = readHookState(configDir);
    const debounceMs = (io.debounceMinutes ?? DEFAULT_DEBOUNCE_MINUTES) * 60_000;
    const t = now();

    // Same (window, status) inside the debounce window → stay silent. A status
    // change always prints (§7.1).
    const unchanged = state.lastKey === key && state.lastStatus === body.status.overall;
    if (unchanged && state.lastPrintedAt !== null && t - state.lastPrintedAt < debounceMs) {
      return 0;
    }

    out(`${line}\n`);
    writeHookState(configDir, { lastKey: key, lastStatus: body.status.overall, lastPrintedAt: t });
    return 0;
  } catch {
    // Unreachable daemon, timeout, malformed body — all mean "no information" (§10).
    return 0;
  }
}

/** Read all of stdin, tolerating a TTY or a closed pipe. */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  try {
    if ((stream as NodeJS.ReadStream).isTTY === true) return '';
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}
