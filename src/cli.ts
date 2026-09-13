import { DaemonClient, DaemonUnreachable, isPidAlive, readDaemonInfo } from './clients/http.js';
import { loadConfig, resolveConfigDir } from './config.js';
import { serve } from './daemon.js';
import { runHook, readStdin } from './hook.js';
import { runStatusline } from './statusline.js';
import { getVersion } from './version.js';
import type { LimitStatus } from './limits/status.js';
import type { NormalizedLimit } from './limits/types.js';
import { isTokensGroupBy } from './server/types.js';

export interface CliIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  configDir?: string;
  client?: Pick<DaemonClient, 'get'>;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

/** Subcommands other waves own; they exist so `help` is honest about the surface. */
const PLANNED = ['install', 'configure', 'uninstall', 'mcp', 'sessions', 'pause', 'resume'];

const HELP = `claude-usage — local usage service for Claude Code sessions

Usage: claude-usage <command> [options]

  serve [--verbose]                 run the daemon in the foreground
  status                            daemon state, limits and today's tokens
  tokens [--since <v>] [--by <g>]   token spend table (since: today|7d|24h|ISO)
  hook                              UserPromptSubmit hook (always exits 0)
  statusline                        one-line status for statusLine.command
  --version                         print the version
  help                              print this help

Not implemented yet: ${PLANNED.join(', ')}

Docs: https://github.com/drmuzikbpn/claude-utilization-mcp
Works with Claude Code. Not affiliated with, endorsed by, or sponsored by Anthropic.
`;

function flagValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    for (const name of names) {
      if (arg === name) return argv[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function formatCount(v: unknown): string {
  return num(v).toLocaleString('en-US');
}

function limitsTable(limits: readonly NormalizedLimit[], byId: Record<string, LimitStatus>): string {
  if (limits.length === 0) return '  (no limits data yet)\n';
  const idWidth = Math.max(8, ...limits.map((l) => l.id.length));
  let out = '';
  for (const l of limits) {
    const percent = l.percent === null ? '  ?' : `${String(l.percent).padStart(3)}`;
    const status = byId[l.id] ?? 'ok';
    const resets = l.resetsAt === null ? 'resets: unknown' : `resets ${l.resetsAt}`;
    out += `  ${pad(l.id, idWidth)}  ${percent}%  ${pad(status, 8)}  ${resets}\n`;
  }
  return out;
}

async function cmdStatus(io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  const info = readDaemonInfo(configDir);

  if (info === null) {
    io.stdout('daemon: not running (no daemon.json)\n');
    io.stdout(`config: ${configDir}\n`);
    return 1;
  }
  if (!isPidAlive(info.pid)) {
    io.stdout(`daemon: not running (stale daemon.json — pid ${info.pid} is gone)\n`);
    io.stdout(`config: ${configDir}\n`);
    return 1;
  }

  const client = io.client ?? new DaemonClient({ configDir });
  let summary: Record<string, unknown>;
  try {
    summary = (await client.get('/v1/summary')) as Record<string, unknown>;
  } catch (err) {
    io.stdout(`daemon: pid ${info.pid} on port ${info.port}, but not answering\n`);
    io.stderr(`  ${(err as Error).message}\n`);
    return 1;
  }

  io.stdout(`daemon: running (pid ${info.pid}, port ${info.port}, version ${info.version || 'unknown'})\n`);

  const limitsBody = summary['limits'] as { limits?: NormalizedLimit[]; stale?: boolean; error?: unknown } | undefined;
  const status = summary['status'] as { byId?: Record<string, LimitStatus>; overall?: LimitStatus } | undefined;
  io.stdout(`overall: ${status?.overall ?? 'unknown'}${limitsBody?.stale === true ? ' (stale)' : ''}\n`);
  const err = limitsBody?.error as { code?: string; message?: string } | null | undefined;
  if (err !== null && err !== undefined && err.code !== undefined) {
    io.stdout(`limits error: ${err.code} — ${err.message ?? ''}\n`);
  }
  io.stdout('limits:\n');
  io.stdout(limitsTable(limitsBody?.limits ?? [], status?.byId ?? {}));

  const today = summary['today'] as Record<string, unknown> | undefined;
  if (today?.['ready'] === true) {
    io.stdout(
      `today: ${formatCount(today['messages'])} messages, ` +
        `in ${formatCount(today['input'])} / out ${formatCount(today['output'])}, ` +
        `cache ${formatCount(today['cacheCreate'])} created / ${formatCount(today['cacheRead'])} read\n`,
    );
  } else {
    io.stdout('today: scanning transcripts…\n');
  }
  return 0;
}

async function cmdTokens(argv: readonly string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  const since = flagValue(argv, ['--since', '-s']) ?? 'today';
  const by = flagValue(argv, ['--by', '-b', '--groupBy']) ?? 'project';
  if (!isTokensGroupBy(by)) {
    io.stderr(`claude-usage: --by must be one of project, session, model, day (got "${by}")\n`);
    return 1;
  }

  const configDir = io.configDir ?? resolveConfigDir();
  const client = io.client ?? new DaemonClient({ configDir });
  let body: Record<string, unknown>;
  try {
    const qs = new URLSearchParams({ since, groupBy: by });
    body = (await client.get(`/v1/tokens?${qs.toString()}`)) as Record<string, unknown>;
  } catch (err) {
    io.stderr(
      err instanceof DaemonUnreachable
        ? 'claude-usage: daemon not running — run `claude-usage status`\n'
        : `claude-usage: ${(err as Error).message}\n`,
    );
    return 1;
  }

  if (body['ready'] !== true) {
    io.stdout('tokens: initial scan still running — try again shortly\n');
    return 0;
  }

  const groups = Array.isArray(body['groups']) ? (body['groups'] as Array<Record<string, unknown>>) : [];
  const totals = (body['totals'] ?? {}) as Record<string, unknown>;
  io.stdout(`since ${String(body['since'])}, grouped by ${by}\n`);
  const labelWidth = Math.max(12, ...groups.map((g) => String(g['label'] ?? g['key'] ?? '').length));
  io.stdout(`  ${pad('group', labelWidth)}  ${'input'.padStart(12)}  ${'output'.padStart(12)}  ${'msgs'.padStart(8)}\n`);
  for (const g of groups) {
    const label = String(g['label'] ?? g['key'] ?? '');
    io.stdout(
      `  ${pad(label, labelWidth)}  ${formatCount(g['input']).padStart(12)}  ` +
        `${formatCount(g['output']).padStart(12)}  ${formatCount(g['messages']).padStart(8)}\n`,
    );
  }
  io.stdout(
    `  ${pad('TOTAL', labelWidth)}  ${formatCount(totals['input']).padStart(12)}  ` +
      `${formatCount(totals['output']).padStart(12)}  ${formatCount(totals['messages']).padStart(8)}\n`,
  );
  return 0;
}

/** Subcommand dispatch. Returns the process exit code; never calls `process.exit`. */
export async function run(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = io.stderr ?? ((t: string) => process.stderr.write(t));
  const base = { ...io, stdout, stderr };
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);

  switch (cmd) {
    case 'serve': {
      const opts = { verbose: rest.includes('--verbose') || rest.includes('-v') };
      return serve(io.configDir === undefined ? opts : { ...opts, configDir: io.configDir });
    }
    case 'status':
      return cmdStatus(base);
    case 'tokens':
      return cmdTokens(rest, base);
    case 'hook': {
      const hookIo = {
        stdin: io.stdin ?? (await readStdin()),
        stdout,
        ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
      };
      return runHook(hookIo);
    }
    case 'statusline': {
      const slIo = {
        stdin: io.stdin ?? (await readStdin()),
        stdout,
        ...(io.configDir === undefined ? {} : { configDir: io.configDir }),
        ...(io.env === undefined ? {} : { env: io.env }),
      };
      return runStatusline(slIo);
    }
    case 'config': {
      const configDir = io.configDir ?? resolveConfigDir();
      stdout(`${JSON.stringify(loadConfig(configDir), null, 2)}\n`);
      return 0;
    }
    case '--version':
    case '-V':
    case 'version':
      stdout(`${getVersion()}\n`);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      stdout(HELP);
      return 0;
    default:
      if (PLANNED.includes(cmd)) {
        stderr(`claude-usage: subcommand "${cmd}" not implemented yet\n`);
        return 1;
      }
      stderr(`claude-usage: unknown subcommand "${cmd}"\n`);
      stderr('run `claude-usage help` for usage\n');
      return 1;
  }
}

export async function main(argv: string[]): Promise<void> {
  const code = await run(argv);
  if (code !== 0) process.exitCode = code;
}
