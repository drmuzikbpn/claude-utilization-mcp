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
 * A cached token reader. `get()` returns the cached token; `get({ fresh: true })`
 * re-reads the credential store (the once-on-401 retry path of §5.1 / §23.3).
 */
export function createTokenReader(opts: GetAccessTokenOptions = {}): (o?: { fresh?: boolean }) => Promise<string> {
  let cached: string | undefined;
  return async (o) => {
    if (cached !== undefined && o?.fresh !== true) return cached;
    cached = await getAccessToken(opts);
    return cached;
  };
}
