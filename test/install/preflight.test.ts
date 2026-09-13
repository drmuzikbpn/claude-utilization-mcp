import { describe, expect, it } from 'vitest';
import { NoCredentialsError } from '../../src/credentials/index.js';
import {
  KEYCHAIN_NOTICE,
  parseNodeMajor,
  preflight,
  renderPreflight,
} from '../../src/install/preflight.js';

const ok = (): Promise<string> => Promise.resolve('token-value-never-printed');

function check(result: Awaited<ReturnType<typeof preflight>>, name: string): { level: string; message: string } {
  const found = result.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no ${name} check`);
  return found;
}

describe('node version', () => {
  it('parses majors', () => {
    expect(parseNodeMajor('v20.11.1')).toBe(20);
    expect(parseNodeMajor('24.0.0')).toBe(24);
    expect(parseNodeMajor('nonsense')).toBeNull();
  });

  it('passes on >= 20', async () => {
    const r = await preflight({ nodeVersion: 'v20.0.0', platform: 'linux', readCredentials: ok });
    expect(check(r, 'node').level).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('warns — never fails — below 20 (2026-09-13 audit)', async () => {
    const r = await preflight({ nodeVersion: 'v18.19.0', platform: 'linux', readCredentials: ok });
    expect(check(r, 'node').level).toBe('warn');
    expect(check(r, 'node').message).toContain('v18.19.0');
    expect(r.ok).toBe(true);
  });

  it('warns on an unparseable version', async () => {
    const r = await preflight({ nodeVersion: 'weird', platform: 'linux', readCredentials: ok });
    expect(check(r, 'node').level).toBe('warn');
    expect(r.ok).toBe(true);
  });
});

describe('platform', () => {
  it.each(['darwin', 'linux'])('accepts %s', async (platform) => {
    const r = await preflight({ nodeVersion: 'v20.0.0', platform, readCredentials: ok });
    expect(check(r, 'platform').level).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('fails on anything else and does not touch credentials', async () => {
    let touched = false;
    const r = await preflight({
      nodeVersion: 'v20.0.0',
      platform: 'win32',
      readCredentials: async () => {
        touched = true;
        return '';
      },
    });
    expect(check(r, 'platform').level).toBe('fail');
    expect(r.ok).toBe(false);
    expect(touched).toBe(false);
    expect(r.checks.some((c) => c.name === 'credentials')).toBe(false);
  });
});

describe('credentials', () => {
  it('warns before the first Keychain access on darwin, and only on darwin', async () => {
    const seen: string[] = [];
    await preflight({ nodeVersion: 'v20.0.0', platform: 'darwin', notify: (l) => seen.push(l), readCredentials: ok });
    expect(seen).toEqual([KEYCHAIN_NOTICE]);

    const linux: string[] = [];
    await preflight({ nodeVersion: 'v20.0.0', platform: 'linux', notify: (l) => linux.push(l), readCredentials: ok });
    expect(linux).toEqual([]);
  });

  it('prints the notice before the read happens', async () => {
    const order: string[] = [];
    await preflight({
      nodeVersion: 'v20.0.0',
      platform: 'darwin',
      notify: () => order.push('notice'),
      readCredentials: async () => {
        order.push('read');
        return '';
      },
    });
    expect(order).toEqual(['notice', 'read']);
  });

  it('warns — not fails — when credentials are unreadable, and carries the hint', async () => {
    const r = await preflight({
      nodeVersion: 'v20.0.0',
      platform: 'darwin',
      readCredentials: () => Promise.reject(new NoCredentialsError('Keychain item not readable')),
    });
    expect(check(r, 'credentials').level).toBe('warn');
    expect(check(r, 'credentials').message).toContain('run `claude` to log in');
    expect(check(r, 'credentials').message).toContain('no_credentials');
    expect(r.ok).toBe(true);
  });

  it('never prints the token value', async () => {
    const r = await preflight({
      nodeVersion: 'v20.0.0',
      platform: 'linux',
      readCredentials: () => Promise.resolve('sk-super-secret-value'),
    });
    expect(renderPreflight(r)).not.toContain('sk-super-secret-value');
  });
});

describe('rendering', () => {
  it('one line per check with a level marker', async () => {
    const r = await preflight({ nodeVersion: 'v18.0.0', platform: 'linux', readCredentials: ok });
    const text = renderPreflight(r);
    expect(text.trimEnd().split('\n')).toHaveLength(3);
    expect(text).toContain('[ok  ] platform: linux');
    expect(text).toContain('[warn] node:');
  });
});
