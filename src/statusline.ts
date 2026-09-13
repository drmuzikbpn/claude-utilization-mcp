import { DaemonClient } from './clients/http.js';
import { resolveConfigDir } from './config.js';
import type { LimitStatus } from './limits/status.js';
import type { NormalizedLimit } from './limits/types.js';
import { HEADLINE_IDS, parseHookStdin, type SummaryBody } from './hook.js';

export const STATUSLINE_TIMEOUT_MS = 400;
export const SEPARATOR = ' · ';

const SHORT_LABELS: Record<string, string> = { session: '5h', weekly_all: '7d' };

const ANSI: Record<LimitStatus, string> = {
  ok: '',
  warn: '\u001b[33m',
  critical: '\u001b[31m',
};
const RESET = '\u001b[0m';

export interface StatuslineIO {
  stdin?: string;
  stdout?: (text: string) => void;
  configDir?: string;
  client?: Pick<DaemonClient, 'get'>;
  timeoutMs?: number;
  /** Force colour on/off; defaults to "colour unless NO_COLOR is set". */
  color?: boolean;
  env?: NodeJS.ProcessEnv;
}

function colorize(text: string, status: LimitStatus, color: boolean): string {
  if (!color || ANSI[status] === '') return text;
  return `${ANSI[status]}${text}${RESET}`;
}

function segment(limit: NormalizedLimit, status: LimitStatus, color: boolean): string {
  const label = SHORT_LABELS[limit.id] ?? limit.id;
  const percent = limit.percent === null ? '?%' : `${limit.percent}%`;
  return colorize(`${label} ${percent}`, status, color);
}

/** `5h 42% · 7d 61%` from the `session` / `weekly_all` limits; `null` when neither exists. */
export function formatStatusline(summary: SummaryBody, color: boolean): string | null {
  const parts: string[] = [];
  for (const id of HEADLINE_IDS) {
    const limit = summary.limits.limits.find((l) => l.id === id);
    if (limit === undefined) continue;
    parts.push(segment(limit, summary.status.byId[id] ?? 'ok', color));
  }
  return parts.length === 0 ? null : parts.join(SEPARATOR);
}

function isSummary(v: unknown): v is SummaryBody {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  const limits = rec['limits'];
  if (typeof limits !== 'object' || limits === null) return false;
  if (!Array.isArray((limits as { limits?: unknown }).limits)) return false;
  const status = rec['status'];
  return typeof status === 'object' && status !== null;
}

/** `claude-usage statusline` (§7.3). Daemon down or any failure → print nothing, exit 0. */
export async function runStatusline(io: StatuslineIO = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text));
  const configDir = io.configDir ?? resolveConfigDir();
  const env = io.env ?? process.env;
  const color = io.color ?? (env['NO_COLOR'] === undefined || env['NO_COLOR'] === '');

  try {
    // Claude Code passes session JSON on stdin; we read and ignore it for now.
    parseHookStdin(io.stdin);

    const client = io.client ?? new DaemonClient({ configDir, timeoutMs: io.timeoutMs ?? STATUSLINE_TIMEOUT_MS });
    const body = await client.get('/v1/summary', { timeoutMs: io.timeoutMs ?? STATUSLINE_TIMEOUT_MS });
    if (!isSummary(body)) return 0;

    const line = formatStatusline(body, color);
    if (line === null) return 0;
    out(`${line}\n`);
    return 0;
  } catch {
    return 0;
  }
}
