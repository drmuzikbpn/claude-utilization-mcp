import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NoCredentialsError, parseCredentialsJson } from './types.js';

export function defaultCredentialsPath(home: string = homedir()): string {
  return join(home, '.claude', '.credentials.json');
}

/** Linux: `~/.claude/.credentials.json`, same JSON shape as the Keychain item. */
export async function getAccessTokenFromFile(path: string = defaultCredentialsPath()): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new NoCredentialsError(`${path} does not exist`);
    throw new NoCredentialsError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseCredentialsJson(text, path);
}
