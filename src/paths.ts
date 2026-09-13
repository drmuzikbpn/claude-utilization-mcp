import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * XDG-ish path resolution for everything install/uninstall touches (§20, §23.9).
 *
 * Every function takes the environment explicitly so tests can point HOME and the
 * XDG variables at a temp directory and never reach the real dotfiles.
 */

export const APP = 'claude-usage';

/** `$HOME`, falling back to `os.homedir()`. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env['HOME'];
  return typeof h === 'string' && h.length > 0 ? h : homedir();
}

function xdg(env: NodeJS.ProcessEnv, key: string, ...fallback: string[]): string {
  const v = env[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return join(resolveHome(env), ...fallback);
}

/** `$XDG_DATA_HOME`, falling back to `~/.local/share`. */
export function resolveDataHome(env: NodeJS.ProcessEnv = process.env): string {
  return xdg(env, 'XDG_DATA_HOME', '.local', 'share');
}

/** `$XDG_CONFIG_HOME`, falling back to `~/.config`. Mirrors `config.resolveConfigDir`. */
export function resolveConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return xdg(env, 'XDG_CONFIG_HOME', '.config');
}

/** `<data home>/claude-usage` — the versions layout root (§20). */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataHome(env), APP);
}

export function versionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'versions');
}

export function versionDir(version: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(versionsDir(env), version);
}

/** `<data home>/claude-usage/current` — the symlink the service unit runs out of. */
export function currentLink(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'current');
}

/** The binary path baked into the unit file, the hook command and the MCP entry. */
export function currentBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(currentLink(env), 'bin', APP);
}

/** macOS only: launchd log destination (§23.9). Linux logs go to the journal. */
export function macLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHome(env), 'Library', 'Logs', APP);
}

export function launchAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHome(env), 'Library', 'LaunchAgents');
}

export function systemdUserDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveConfigHome(env), 'systemd', 'user');
}

/** `~/.claude` — Claude Code's own directory. */
export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHome(env), '.claude');
}

/** `~/.claude/settings.json` — merge-only (§23.11). */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeDir(env), 'settings.json');
}

/** `~/.claude.json` — Claude Code's live state file, 0600 (§23.10). */
export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHome(env), '.claude.json');
}
