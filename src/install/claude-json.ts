import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultExec, type ExecRunner } from '../service/index.js';

/**
 * MCP registration in `~/.claude.json` (§7.2, §23.10).
 *
 * `~/.claude.json` is Claude Code's live 0600 state file, rewritten by running
 * sessions. Primary path delegates the write to `claude mcp add/remove`; the
 * fallback re-reads, merges and renames a 0600 temp file in the same directory.
 * There is deliberately **no `.bak`** — one would leak 0600 content at 0644.
 */

export const MCP_KEY = 'claude-usage';
export const CLAUDE_JSON_MODE = 0o600;

export type McpMethod = 'claude-cli' | 'fallback';

export interface McpResult {
  method: McpMethod;
  changed: boolean;
  /** Shown to the user — e.g. the "quit running sessions" advice on the fallback path. */
  warning: string | null;
}

export interface McpOptions {
  /** Absolute path to `~/.claude.json`. */
  file: string;
  /** Absolute path to `<data>/claude-usage/current/bin/claude-usage`. */
  binPath: string;
  exec?: ExecRunner;
}

export const FALLBACK_WARNING =
  '~/.claude.json was edited directly (no `claude` on PATH) — quit running Claude Code sessions before using the MCP server, or they will overwrite it';

/** The entry we register. `type: "stdio"` is required (§23.10). */
export function mcpEntry(binPath: string): Record<string, unknown> {
  return { type: 'stdio', command: binPath, args: ['mcp'] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read `~/.claude.json`; missing → `{}`; malformed → `null` (the caller warns). */
function readClaudeJson(file: string): { json: Record<string, unknown>; mode: number } | null {
  if (!existsSync(file)) return { json: {}, mode: CLAUDE_JSON_MODE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return { json: parsed, mode: statSync(file).mode & 0o777 };
}

/** Temp file in the same directory, then `rename(2)` — mode preserved, no `.bak`. */
function writeClaudeJson(file: string, json: Record<string, unknown>, mode: number): void {
  const tmp = join(dirname(file), `.claude.json.claude-usage.${String(process.pid)}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, { mode });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

/** `code: 127` from the runner means `claude` is not on PATH. */
async function tryClaudeCli(exec: ExecRunner, args: readonly string[]): Promise<boolean> {
  const result = await exec('claude', args);
  if (result.code === 127) return false;
  if (result.code !== 0) {
    throw new Error(`\`claude ${args.join(' ')}\` failed (exit ${String(result.code)}): ${result.stderr.trim()}`);
  }
  return true;
}

/** Register the MCP server. Primary: `claude mcp add --scope user` (§23.10). */
export async function addMcpServer(opts: McpOptions): Promise<McpResult> {
  const exec = opts.exec ?? defaultExec;
  if (await tryClaudeCli(exec, ['mcp', 'add', '--scope', 'user', MCP_KEY, '--', opts.binPath, 'mcp'])) {
    return { method: 'claude-cli', changed: true, warning: null };
  }

  const loaded = readClaudeJson(opts.file);
  if (loaded === null) {
    throw new Error(`${opts.file} is not valid JSON — aborting, nothing written`);
  }
  const servers = isRecord(loaded.json['mcpServers']) ? (loaded.json['mcpServers'] as Record<string, unknown>) : {};
  loaded.json['mcpServers'] = servers;
  const before = JSON.stringify(servers[MCP_KEY]);
  servers[MCP_KEY] = mcpEntry(opts.binPath);
  const changed = JSON.stringify(servers[MCP_KEY]) !== before;
  if (changed) writeClaudeJson(opts.file, loaded.json, loaded.mode);
  return { method: 'fallback', changed, warning: FALLBACK_WARNING };
}

/** Remove the MCP server. Primary: `claude mcp remove --scope user` (§23.10). */
export async function removeMcpServer(opts: McpOptions): Promise<McpResult> {
  const exec = opts.exec ?? defaultExec;
  const result = await exec('claude', ['mcp', 'remove', '--scope', 'user', MCP_KEY]);
  // A non-zero exit that is not "command not found" usually means "no such server" —
  // uninstall must stay idempotent, so that is not an error.
  if (result.code !== 127) return { method: 'claude-cli', changed: result.code === 0, warning: null };

  const loaded = readClaudeJson(opts.file);
  if (loaded === null || !existsSync(opts.file)) {
    return { method: 'fallback', changed: false, warning: null };
  }
  const servers = loaded.json['mcpServers'];
  if (!isRecord(servers) || servers[MCP_KEY] === undefined) {
    return { method: 'fallback', changed: false, warning: null };
  }
  delete servers[MCP_KEY];
  if (Object.keys(servers).length === 0) delete loaded.json['mcpServers'];
  writeClaudeJson(opts.file, loaded.json, loaded.mode);
  return { method: 'fallback', changed: true, warning: FALLBACK_WARNING };
}
