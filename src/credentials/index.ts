import { getAccessTokenFromFile } from './file.js';
import { getAccessTokenFromKeychain, type CommandRunner } from './keychain.js';
import { UnsupportedPlatformError } from './types.js';

export * from './types.js';
export { getAccessTokenFromFile, defaultCredentialsPath } from './file.js';
export { getAccessTokenFromKeychain, KEYCHAIN_SERVICE, type CommandRunner, type CommandResult } from './keychain.js';

export interface GetAccessTokenOptions {
  /** Overridden in tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform | string;
  /** Injected runner for the macOS Keychain path. */
  runner?: CommandRunner;
  /** Overrides the Linux credentials file path. */
  credentialsPath?: string;
}

/**
 * Resolve the Claude Code OAuth access token for the current platform (§5.1).
 * We never refresh tokens — Claude Code owns refresh.
 *
 * The returned value is a credential: never log it, never put it in an error message.
 */
export async function getAccessToken(opts: GetAccessTokenOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    return opts.runner ? getAccessTokenFromKeychain(opts.runner) : getAccessTokenFromKeychain();
  }
  if (platform === 'linux') {
    return opts.credentialsPath ? getAccessTokenFromFile(opts.credentialsPath) : getAccessTokenFromFile();
  }
  throw new UnsupportedPlatformError(String(platform));
}

/**
 * How long a read token is trusted before the credential store is consulted again.
 *
 * Deliberately the same 10 min as `USER_REFRESH_MS` in `server/identity.ts`. The two
 * refreshes answer the same question from different stores — who is this daemon acting
 * as — and §23.31 is what happens when they disagree: identity re-read on its timer and
 * moved to the new account while the token did not, so the daemon reported the new
 * address beside the previous account's percentages. Keep the two constants equal.
 */
export const TOKEN_REFRESH_MS = 600_000;

export interface TokenReaderOptions extends GetAccessTokenOptions {
  /** Re-read the credential store once the cached token is this old (§23.31). */
  ttlMs?: number;
  /** Injected clock (tests). */
  now?: () => number;
}

/**
 * A cached token reader. `get()` returns the cached token until `ttlMs` has passed;
 * `get({ fresh: true })` re-reads immediately (the once-on-401 retry path of §5.1 / §23.3).
 *
 * The TTL is not an optimisation — it is the correctness property. Caching forever was
 * safe only under the assumption that a stale token 401s, and an account switch breaks
 * exactly that: the previous account's token stays valid, every poll succeeds, and
 * nothing ever triggers the fresh re-read (§23.31).
 */
export function createTokenReader(opts: TokenReaderOptions = {}): (o?: { fresh?: boolean }) => Promise<string> {
  const ttlMs = opts.ttlMs ?? TOKEN_REFRESH_MS;
  const now = opts.now ?? Date.now;
  let cached: string | undefined;
  let readAt = 0;
  return async (o) => {
    const t = now();
    if (cached !== undefined && o?.fresh !== true && t - readAt < ttlMs) return cached;
    cached = await getAccessToken(opts);
    readAt = t;
    return cached;
  };
}
