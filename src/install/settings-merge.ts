import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../config.js';

/**
 * Merge-only edits to `~/.claude/settings.json` (§7.1, §7.3, §23.11).
 *
 * Rules that are not negotiable:
 * - unrelated keys are never touched, and key order survives a round-trip;
 * - one group per event, appended, with no `matcher`;
 * - idempotent — re-running adds nothing;
 * - the `.bak` is written ONCE and never overwritten, copying the source mode;
 * - malformed JSON aborts naming the path, and nothing is written;
 * - the write is atomic and preserves the file's mode.
 */

export interface HookRegistration {
  event: string;
  /** Seconds — 5 for the session events, 86400 for the gate events (§23.11). */
  timeoutSeconds: number;
}

export const HOOK_EVENTS: readonly HookRegistration[] = [
  { event: 'SessionStart', timeoutSeconds: 5 },
  { event: 'SessionEnd', timeoutSeconds: 5 },
  { event: 'UserPromptSubmit', timeoutSeconds: 86_400 },
  { event: 'PreToolUse', timeoutSeconds: 86_400 },
];

/** `settings.json.claude-usage.bak` — written once, never overwritten (§23.10). */
export const BACKUP_SUFFIX = '.claude-usage.bak';

export const DEFAULT_SETTINGS_MODE = 0o644;

/** Unreadable / malformed settings. Always names the path; nothing is written. */
export class SettingsError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = 'SettingsError';
    this.path = path;
  }
}

export function hookCommand(binPath: string): string {
  return `${binPath} hook`;
}

export function statuslineCommand(binPath: string): string {
  return `${binPath} statusline`;
}

export function backupPathFor(settingsFile: string): string {
  return `${settingsFile}${BACKUP_SUFFIX}`;
}

/** Is this command string one of ours? Keyed on the resolved binary path (§23.11). */
export function commandTargetsBin(command: unknown, binPath: string): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  return trimmed === binPath || trimmed.startsWith(`${binPath} `);
}

export interface LoadedSettings {
  json: Record<string, unknown>;
  mode: number;
  existed: boolean;
}

/** Read and parse settings. Missing file → `{}`; malformed → `SettingsError`. */
export function readSettingsFile(file: string): LoadedSettings {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { json: {}, mode: DEFAULT_SETTINGS_MODE, existed: false };
    throw new SettingsError(`cannot read ${file}: ${(err as Error).message}`, file);
  }
  const mode = statSync(file).mode & 0o777;
  if (text.trim().length === 0) return { json: {}, mode, existed: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`${file} is not valid JSON (${(err as Error).message}) — aborting, nothing written`, file);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SettingsError(`${file} is not a JSON object — aborting, nothing written`, file);
  }
  return { json: parsed as Record<string, unknown>, mode, existed: true };
}

/** Atomic write at `mode`, creating `~/.claude` when it is missing. */
export function writeSettingsFile(file: string, json: Record<string, unknown>, mode: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(json, null, 2)}\n`, mode);
}

/** Copy the file to its `.bak` exactly once, preserving the source mode. */
export function backupOnce(file: string): string | null {
  const backup = backupPathFor(file);
  if (!existsSync(file) || existsSync(backup)) return null;
  copyFileSync(file, backup);
  return backup;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function groupIsOurs(group: unknown, binPath: string): boolean {
  const rec = asRecord(group);
  if (rec === null) return false;
  const hooks = rec['hooks'];
  if (!Array.isArray(hooks)) return false;
  return hooks.some((entry) => commandTargetsBin(asRecord(entry)?.['command'], binPath));
}

/** The single group we append per event — no `matcher` key (§23.11). */
export function ourHookGroup(binPath: string, timeoutSeconds: number): Record<string, unknown> {
  return { hooks: [{ type: 'command', command: hookCommand(binPath), timeout: timeoutSeconds }] };
}

export interface HookMergeResult {
  added: string[];
  alreadyPresent: string[];
}

/** Append our group to every event that does not already have it. Mutates `json`. */
export function addHookGroups(json: Record<string, unknown>, binPath: string): HookMergeResult {
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  let hooks = asRecord(json['hooks']);
  if (hooks === null) {
    hooks = {};
    json['hooks'] = hooks;
  }
  for (const { event, timeoutSeconds } of HOOK_EVENTS) {
    const existing = hooks[event];
    const groups = Array.isArray(existing) ? existing : [];
    if (!Array.isArray(existing)) hooks[event] = groups;
    if (groups.some((g) => groupIsOurs(g, binPath))) {
      alreadyPresent.push(event);
      continue;
    }
    groups.push(ourHookGroup(binPath, timeoutSeconds));
    added.push(event);
  }
  return { added, alreadyPresent };
}

/**
 * Remove exactly our groups. Arrays and the `hooks` object we created are deleted
 * when they end up empty, so install → uninstall is byte-identical to the original.
 */
export function removeHookGroups(json: Record<string, unknown>, binPath: string): string[] {
  const hooks = asRecord(json['hooks']);
  if (hooks === null) return [];
  const removed: string[] = [];
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !groupIsOurs(g, binPath));
    if (kept.length === groups.length) continue;
    removed.push(event);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete json['hooks'];
  return removed;
}

export type StatusLineOutcome = 'set' | 'already-ours' | 'other-exists';

export interface StatusLineResult {
  outcome: StatusLineOutcome;
  /** Printed for the user to paste into their own script when one already exists (§7.3). */
  snippet: string;
}

/** Set `statusLine` only when absent; otherwise report the snippet (§7.3). */
export function addStatusLine(json: Record<string, unknown>, binPath: string): StatusLineResult {
  const snippet = statuslineCommand(binPath);
  const existing = asRecord(json['statusLine']);
  if (existing === null && json['statusLine'] === undefined) {
    json['statusLine'] = { type: 'command', command: snippet };
    return { outcome: 'set', snippet };
  }
  if (existing !== null && commandTargetsBin(existing['command'], binPath)) {
    return { outcome: 'already-ours', snippet };
  }
  return { outcome: 'other-exists', snippet };
}

/** Remove `statusLine` only when it is ours. */
export function removeStatusLine(json: Record<string, unknown>, binPath: string): boolean {
  const existing = asRecord(json['statusLine']);
  if (existing === null || !commandTargetsBin(existing['command'], binPath)) return false;
  delete json['statusLine'];
  return true;
}

export interface SettingsApplyOptions {
  file: string;
  binPath: string;
  hook: boolean;
  statusline: boolean;
}

export interface SettingsApplyResult {
  changed: boolean;
  backupPath: string | null;
  hooksAdded: string[];
  hooksAlreadyPresent: string[];
  statusLine: StatusLineResult | null;
}

/** Install our hook groups and (optionally) the status line, in one read/write pass. */
export function applySettings(opts: SettingsApplyOptions): SettingsApplyResult {
  const { json, mode, existed } = readSettingsFile(opts.file);
  const before = JSON.stringify(json);

  const hookResult = opts.hook ? addHookGroups(json, opts.binPath) : { added: [], alreadyPresent: [] };
  const statusLine = opts.statusline ? addStatusLine(json, opts.binPath) : null;

  const changed = JSON.stringify(json) !== before;
  let backupPath: string | null = null;
  if (changed) {
    if (existed) backupPath = backupOnce(opts.file);
    writeSettingsFile(opts.file, json, mode);
  }
  return {
    changed,
    backupPath,
    hooksAdded: hookResult.added,
    hooksAlreadyPresent: hookResult.alreadyPresent,
    statusLine,
  };
}

export interface SettingsRemoveOptions {
  file: string;
  binPath: string;
  hook: boolean;
  statusline: boolean;
}

export interface SettingsRemoveResult {
  changed: boolean;
  hooksRemoved: string[];
  statusLineRemoved: boolean;
}

/** Uninstall / `configure … off`: remove exactly what we added. Never touches the `.bak`. */
export function removeSettings(opts: SettingsRemoveOptions): SettingsRemoveResult {
  const { json, mode, existed } = readSettingsFile(opts.file);
  if (!existed) return { changed: false, hooksRemoved: [], statusLineRemoved: false };
  const before = JSON.stringify(json);

  const hooksRemoved = opts.hook ? removeHookGroups(json, opts.binPath) : [];
  const statusLineRemoved = opts.statusline ? removeStatusLine(json, opts.binPath) : false;

  const changed = JSON.stringify(json) !== before;
  if (changed) writeSettingsFile(opts.file, json, mode);
  return { changed, hooksRemoved, statusLineRemoved };
}
