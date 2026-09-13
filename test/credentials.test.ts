import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTokenReader,
  getAccessToken,
  getAccessTokenFromFile,
  getAccessTokenFromKeychain,
  KEYCHAIN_SERVICE,
  NoCredentialsError,
  UnsupportedPlatformError,
  parseCredentialsJson,
  type CommandResult,
  type CommandRunner,
} from '../src/credentials/index.js';

const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN';
const GOOD_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: FAKE_TOKEN,
    refreshToken: 'sk-ant-ort01-FAKE',
    expiresAt: 1_800_000_000_000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default',
  },
});

function runner(result: Partial<CommandResult>, capture?: string[][]): CommandRunner {
  return async (file, args) => {
    capture?.push([file, ...args]);
    return { stdout: '', stderr: '', code: 0, ...result };
  };
}

describe('parseCredentialsJson', () => {
  it('extracts claudeAiOauth.accessToken', () => {
    expect(parseCredentialsJson(GOOD_JSON, 'src')).toBe(FAKE_TOKEN);
  });

  it.each([
    ['invalid JSON', '{oops', /not valid JSON/],
    ['non-object', '"hi"', /not a JSON object/],
    ['missing claudeAiOauth', '{}', /claudeAiOauth/],
    ['missing accessToken', '{"claudeAiOauth":{}}', /accessToken/],
    ['empty accessToken', '{"claudeAiOauth":{"accessToken":""}}', /accessToken/],
  ])('throws NoCredentialsError for %s', (_label, text, re) => {
    expect(() => parseCredentialsJson(text, 'src')).toThrow(NoCredentialsError);
    expect(() => parseCredentialsJson(text, 'src')).toThrow(re);
  });
});

describe('keychain', () => {
  it('spawns the documented security command', async () => {
    const calls: string[][] = [];
    const token = await getAccessTokenFromKeychain(runner({ stdout: `${GOOD_JSON}\n` }, calls));
    expect(token).toBe(FAKE_TOKEN);
    expect(calls[0]).toEqual(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  });

  it('reports a non-zero exit without leaking stdout', async () => {
    await expect(getAccessTokenFromKeychain(runner({ code: 44, stdout: FAKE_TOKEN }))).rejects.toThrow(
      NoCredentialsError,
    );
    await expect(getAccessTokenFromKeychain(runner({ code: 44, stdout: FAKE_TOKEN }))).rejects.not.toThrow(
      new RegExp(FAKE_TOKEN),
    );
  });

  it('reports empty output', async () => {
    await expect(getAccessTokenFromKeychain(runner({ stdout: '  \n' }))).rejects.toThrow(/empty/);
  });

  it('reports a runner that throws', async () => {
    const boom: CommandRunner = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(getAccessTokenFromKeychain(boom)).rejects.toThrow(/security/);
  });
});

describe('file', () => {
  it('reads the credentials file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-creds-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, GOOD_JSON);
    expect(await getAccessTokenFromFile(file)).toBe(FAKE_TOKEN);
  });

  it('reports a missing file by path', async () => {
    await expect(getAccessTokenFromFile('/nope/missing.json')).rejects.toThrow(/does not exist/);
  });
});

describe('platform selection', () => {
  it('uses the Keychain on darwin', async () => {
    const calls: string[][] = [];
    const token = await getAccessToken({ platform: 'darwin', runner: runner({ stdout: GOOD_JSON }, calls) });
    expect(token).toBe(FAKE_TOKEN);
    expect(calls).toHaveLength(1);
  });

  it('uses the credentials file on linux', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-creds-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, GOOD_JSON);
    expect(await getAccessToken({ platform: 'linux', credentialsPath: file })).toBe(FAKE_TOKEN);
  });

  it('throws UnsupportedPlatformError on win32', async () => {
    await expect(getAccessToken({ platform: 'win32' })).rejects.toThrow(UnsupportedPlatformError);
  });
});

describe('createTokenReader', () => {
  it('caches until fresh is requested', async () => {
    const calls: string[][] = [];
    const read = createTokenReader({ platform: 'darwin', runner: runner({ stdout: GOOD_JSON }, calls) });
    await read();
    await read();
    expect(calls).toHaveLength(1);
    await read({ fresh: true });
    expect(calls).toHaveLength(2);
  });
});
