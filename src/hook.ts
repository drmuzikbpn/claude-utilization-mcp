import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from './clients/http.js';
import { CONFIG_DIR_MODE, CONFIG_FILE_MODE, resolveConfigDir, writeJsonFile } from './config.js';
import { absoluteGitCommonDir } from './sessions/registry.js';
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
  /** `PreToolUse` only — recorded as the session's `lastTool` (§23.13). */
  tool_name?: string;
  /** `SessionStart` only: `startup` | `resume` | `clear` | `compact`. */
  source?: string;
}

/** §18.2: how long the gate sleeps between re-polls while a session is paused. */
export const GATE_POLL_MS = 1_000;
/** The registered hook timeout is 86 400 s (§23.11); the gate never outlives it. */
export const GATE_MAX_MS = 86_400_000;
/** Deadline for the one-shot git probe run at SessionStart (§17.1). */
export const GIT_TIMEOUT_MS = 2_000;
export const PAUSED_DIR = 'paused';

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

/** What the hook needs from a daemon client. `post` is optional so older fakes still fit. */
export interface HookClient {
  get(path: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  post?(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface HookIO {
  /** Raw stdin JSON; the hook reads and tolerates anything. */
  stdin?: string;
  stdout?: (text: string) => void;
  configDir?: string;
  client?: HookClient;
  now?: () => number;
  deadlineMs?: number;
  debounceMinutes?: number;
  // --- W3 seams (§17.1, §18.2) ---------------------------------------------
  /** The `claude` process. Defaults to `process.ppid`. */
  ppid?: number;
  /** Overrides the one-shot repository probe. */
  gitCommonDir?: (cwd: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
  gatePollMs?: number;
  /** Hard stop for the gate loop, so a test can never hang. */
  gateMaxMs?: number;
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

// --- W3: session lifecycle & the soft-pause gate (§17.1, §18.2) -------------

/**
 * `git rev-parse --git-common-dir`, run once in `cwd` and resolved to an absolute path
 * (§17.1). Any failure — not a repository, no git, slow disk — is `null`.
 */
export function detectGitCommonDir(cwd: string): string | null {
  if (cwd.length === 0) return null;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const abs = absoluteGitCommonDir(out, cwd);
    return abs.length === 0 ? null : abs;
  } catch {
    return null;
  }
}

/** §18.2: `<configDir>/paused/<sessionId>`, read by the status line. */
export function pausedMarkerPath(configDir: string, sessionId: string): string {
  return join(configDir, PAUSED_DIR, sessionId);
}

function setPausedMarker(configDir: string, sessionId: string, contents: string | null): void {
  if (sessionId.length === 0) return;
  const file = pausedMarkerPath(configDir, sessionId);
  try {
    if (contents === null) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(join(configDir, PAUSED_DIR), { recursive: true, mode: CONFIG_DIR_MODE });
    writeFileSync(file, contents, { mode: CONFIG_FILE_MODE });
  } catch {
    // The marker is cosmetic; never let it affect the session.
  }
}

export interface GateBody {
  paused: boolean;
  mode?: string | null;
  ruleId?: string | null;
  reason?: string | null;
}

function isGateBody(v: unknown): v is GateBody {
  return typeof v === 'object' && v !== null && typeof (v as { paused?: unknown }).paused === 'boolean';
}

async function postQuietly(client: HookClient, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  if (typeof client.post !== 'function') return null;
  try {
    return await client.post(path, body, { timeoutMs });
  } catch {
    // A hook never reports daemon trouble (§10).
    return null;
  }
}

/**
 * §18.2's gate: while `paused`, sleep 1 s and re-poll. A daemon we cannot reach means
 * **not paused** — a hook must never wedge a session.
 */
export async function runGate(
  client: HookClient,
  sessionId: string,
  tool: string | undefined,
  io: HookIO,
  configDir: string,
): Promise<boolean> {
  if (sessionId.length === 0) return false;
  const now = io.now ?? Date.now;
  const deadlineMs = io.deadlineMs ?? HOOK_DEADLINE_MS;
  const pollMs = io.gatePollMs ?? GATE_POLL_MS;
  const maxMs = io.gateMaxMs ?? GATE_MAX_MS;
  const sleep =
    io.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }));

  const startedAt = now();
  let everPaused = false;
  let query = tool === undefined || tool.length === 0 ? '' : `?tool=${encodeURIComponent(tool)}`;
  for (;;) {
    let body: unknown;
    try {
      // The gate poll uses the client's own deadline, not the 200 ms nudge deadline.
      body = await client.get(`/v1/sessions/${encodeURIComponent(sessionId)}/gate${query}`, { timeoutMs: deadlineMs });
    } catch {
      setPausedMarker(configDir, sessionId, null);
      return everPaused;
    }
    query = '';
    if (!isGateBody(body) || !body.paused) {
      setPausedMarker(configDir, sessionId, null);
      return everPaused;
    }
    everPaused = true;
    setPausedMarker(
      configDir,
      sessionId,
      `${JSON.stringify({ mode: body.mode ?? 'soft', ruleId: body.ruleId ?? null, reason: body.reason ?? '' })}\n`,
    );
    if (now() - startedAt >= maxMs) {
      setPausedMarker(configDir, sessionId, null);
      return everPaused;
    }
    await sleep(pollMs);
  }
}

/** The §7.1 nudge, unchanged: one `/v1/summary` call with a 200 ms deadline. */
async function runNudge(io: HookIO, client: HookClient, configDir: string): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text));
  const now = io.now ?? Date.now;
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
}

/**
 * `claude-usage hook` (§7.1, §17.1, §18.2). Dispatches on `hook_event_name`:
 *
 * | event | action |
 * | --- | --- |
 * | `SessionStart` | register `{ sessionId, pid: ppid, cwd, transcriptPath, gitCommonDir, source }` |
 * | `UserPromptSubmit` | heartbeat → gate → limits nudge |
 * | `PreToolUse` | gate only, carrying `?tool=<tool_name>` |
 * | `SessionEnd` | end the session |
 *
 * Any failure prints nothing and the exit code is always 0, so a hook can never slow or
 * break a session.
 */
export async function runHook(io: HookIO = {}): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  const deadlineMs = io.deadlineMs ?? HOOK_DEADLINE_MS;

  try {
    const input = parseHookStdin(io.stdin);
    const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';
    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';
    const client: HookClient = io.client ?? new DaemonClient({ configDir, timeoutMs: deadlineMs });

    if (event === 'SessionStart') {
      if (sessionId.length === 0) return 0;
      const probe = io.gitCommonDir ?? detectGitCommonDir;
      await postQuietly(
        client,
        '/v1/sessions/register',
        {
          sessionId,
          pid: io.ppid ?? process.ppid,
          cwd,
          transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
          gitCommonDir: probe(cwd),
          source: typeof input.source === 'string' ? input.source : null,
        },
        deadlineMs,
      );
      return 0;
    }

    if (event === 'SessionEnd') {
      if (sessionId.length === 0) return 0;
      setPausedMarker(configDir, sessionId, null);
      await postQuietly(client, `/v1/sessions/${encodeURIComponent(sessionId)}/end`, {}, deadlineMs);
      return 0;
    }

    if (event === 'PreToolUse') {
      const tool = typeof input.tool_name === 'string' ? input.tool_name : undefined;
      await runGate(client, sessionId, tool, io, configDir);
      return 0;
    }

    // `UserPromptSubmit` (and anything we do not recognise): heartbeat, gate, then nudge.
    if (sessionId.length > 0) {
      await postQuietly(client, `/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {}, deadlineMs);
      await runGate(client, sessionId, undefined, io, configDir);
    }
    return await runNudge(io, client, configDir);
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
