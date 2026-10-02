/**
 * `/health.install` (§23.48): what this machine has wired into Claude Code, so a remote app's
 * setup check can say "hooks are missing — run `claude-usage install`" instead of guessing.
 *
 * Read-only, best-effort, never throws, and never reports a path. File reads are cached for
 * 60 s; the server adds the live listener list on top.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { commandTargetsBin, groupIsOurs, HOOK_EVENTS } from '../install/settings-merge.js';
import { claudeJsonPath, currentBin, settingsPath } from '../paths.js';

export const INSTALL_CACHE_MS = 60_000;
/** A statusLine script larger than this is not read. */
const SCRIPT_MAX_BYTES = 64 * 1024;
const OUR_NAME = 'claude-usage';
/** `mcpServers` key we register — `MCP_KEY` in install/claude-json.ts, which the daemon does not load. */
const MCP_KEY = 'claude-usage';

export type StatuslineState = 'ours' | 'includes-ours' | 'other' | 'none';

export interface InstallFiles {
  hooks: boolean;
  statusline: StatuslineState;
  /** `null` when `~/.claude.json` exists but cannot be read or parsed. */
  mcp: boolean | null;
}

export interface InstallPaths {
  settingsFile: string;
  claudeJsonFile: string;
  /** The `current/bin/claude-usage` path our hooks and statusLine name. */
  binPath: string;
}

export function defaultInstallPaths(env: NodeJS.ProcessEnv = process.env): InstallPaths {
  return { settingsFile: settingsPath(env), claudeJsonFile: claudeJsonPath(env), binPath: currentBin(env) };
}

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

/** Parsed JSON object; `undefined` when the file is missing, `null` when unreadable/malformed. */
function readJson(file: string): Json | null | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function scriptMentionsUs(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const file = first.startsWith('~/') ? `${homedir()}${first.slice(1)}` : first;
  if (!file.startsWith('/')) return false;
  try {
    if (statSync(file).size > SCRIPT_MAX_BYTES) return false;
    return readFileSync(file, 'utf8').includes(OUR_NAME);
  } catch {
    return false;
  }
}

function statuslineOf(settings: Json | null | undefined, binPath: string): StatuslineState {
  const command = asRecord(settings?.['statusLine'])?.['command'];
  if (typeof command !== 'string' || command.trim().length === 0) return 'none';
  if (commandTargetsBin(command, binPath)) return 'ours';
  // Users with their own statusLine append our command to it (§7.3) — inline or in a script.
  if (command.includes(OUR_NAME) || scriptMentionsUs(command)) return 'includes-ours';
  return 'other';
}

function hooksOf(settings: Json | null | undefined, binPath: string): boolean {
  const hooks = asRecord(settings?.['hooks']);
  if (hooks === null) return false;
  return HOOK_EVENTS.every(({ event }) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some((g) => groupIsOurs(g, binPath));
  });
}

function mcpOf(claudeJson: Json | null | undefined): boolean | null {
  if (claudeJson === undefined) return false;
  if (claudeJson === null) return null;
  return asRecord(claudeJson['mcpServers'])?.[MCP_KEY] !== undefined;
}

export function readInstallFiles(p: InstallPaths): InstallFiles {
  try {
    const settings = readJson(p.settingsFile);
    return { hooks: hooksOf(settings, p.binPath), statusline: statuslineOf(settings, p.binPath), mcp: mcpOf(readJson(p.claudeJsonFile)) };
  } catch {
    return { hooks: false, statusline: 'none', mcp: null };
  }
}

/** Cached reader, shared by `/health` and the SSE snapshot (which embeds `healthBody`). */
export function createInstallReader(p: InstallPaths, now: () => number = Date.now, ttlMs = INSTALL_CACHE_MS): () => InstallFiles {
  let cached: InstallFiles | null = null;
  let readAt = 0;
  return () => {
    const t = now();
    if (cached === null || t - readAt >= ttlMs) {
      cached = readInstallFiles(p);
      readAt = t;
    }
    return cached;
  };
}
