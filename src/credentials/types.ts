export type CredentialsErrorCode = 'no_credentials' | 'unsupported_platform';

/** Base class for credential lookup failures. Never carries a token value. */
export class CredentialsError extends Error {
  readonly code: CredentialsErrorCode;
  readonly hint: string | undefined;
  constructor(code: CredentialsErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'CredentialsError';
    this.code = code;
    this.hint = hint;
  }
}

export class NoCredentialsError extends CredentialsError {
  constructor(message: string, hint = 'run `claude` to log in') {
    super('no_credentials', message, hint);
    this.name = 'NoCredentialsError';
  }
}

export class UnsupportedPlatformError extends CredentialsError {
  constructor(platform: string) {
    super(
      'unsupported_platform',
      `claude-usage does not support credentials on platform "${platform}"`,
      'supported platforms are macOS (Keychain) and Linux (~/.claude/.credentials.json)',
    );
    this.name = 'UnsupportedPlatformError';
  }
}

/** Shape of the `claudeAiOauth` object stored by Claude Code (see fixtures README). */
export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/**
 * Parse a credentials JSON document and return the access token.
 * Throws `NoCredentialsError` — the message never includes any token material.
 */
export function parseCredentialsJson(text: string, source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NoCredentialsError(`${source} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new NoCredentialsError(`${source} is not a JSON object`);
  }
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null) {
    throw new NoCredentialsError(`${source} has no "claudeAiOauth" object`);
  }
  const token = (oauth as { accessToken?: unknown }).accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new NoCredentialsError(`${source} has no "claudeAiOauth.accessToken"`);
  }
  return token;
}
