import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Verified keys of `~/.claude.json → oauthAccount` (§15). */
export interface OauthAccount {
  emailAddress: string | null;
  accountUuid: string | null;
  organizationUuid: string | null;
  displayName: string | null;
  organizationName: string | null;
}

export const USER_REFRESH_MS = 600_000;

export function defaultClaudeJsonPath(home: string = homedir()): string {
  return join(home, '.claude.json');
}

function pickString(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read `oauthAccount`; a missing file or missing keys yield `null` (§15). Never throws. */
export function readOauthAccount(path: string = defaultClaudeJsonPath()): OauthAccount | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const account = (parsed as { oauthAccount?: unknown }).oauthAccount;
  if (typeof account !== 'object' || account === null || Array.isArray(account)) return null;
  const rec = account as Record<string, unknown>;
  const user: OauthAccount = {
    emailAddress: pickString(rec, 'emailAddress'),
    accountUuid: pickString(rec, 'accountUuid'),
    organizationUuid: pickString(rec, 'organizationUuid'),
    displayName: pickString(rec, 'displayName'),
    organizationName: pickString(rec, 'organizationName'),
  };
  const hasAny = Object.values(user).some((v) => v !== null);
  return hasAny ? user : null;
}

/**
 * Caches `oauthAccount` and re-reads it every 10 min — the account can change on
 * re-login (§15).
 */
export function createUserReader(
  path: string = defaultClaudeJsonPath(),
  now: () => number = Date.now,
  refreshMs: number = USER_REFRESH_MS,
): () => OauthAccount | null {
  let cached: OauthAccount | null = null;
  let readAt: number | null = null;
  return () => {
    const t = now();
    if (readAt === null || t - readAt >= refreshMs) {
      cached = readOauthAccount(path);
      readAt = t;
    }
    return cached;
  };
}
