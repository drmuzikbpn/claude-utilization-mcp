import { execFile } from 'node:child_process';
import { NoCredentialsError, parseCredentialsJson } from './types.js';

export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable process runner so tests never touch the real Keychain. */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

/**
 * macOS: `security find-generic-password -s "Claude Code-credentials" -w`, then read
 * `claudeAiOauth.accessToken`. The first call may raise a Keychain prompt.
 */
export async function getAccessTokenFromKeychain(runner: CommandRunner = defaultRunner): Promise<string> {
  let result: CommandResult;
  try {
    result = await runner('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  } catch (err) {
    throw new NoCredentialsError(`could not run \`security\`: ${(err as Error).message}`);
  }
  if (result.code !== 0) {
    throw new NoCredentialsError(
      `Keychain item "${KEYCHAIN_SERVICE}" not readable (security exited ${result.code})`,
    );
  }
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new NoCredentialsError(`Keychain item "${KEYCHAIN_SERVICE}" is empty`);
  }
  return parseCredentialsJson(text, `Keychain item "${KEYCHAIN_SERVICE}"`);
}
