// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  DaemonClient,
  DaemonUnreachable,
  daemonFilePath,
  isPidAlive,
  readAuthToken,
  readDaemonInfo,
} from '../src/clients/http.js';
import { startFakeDaemon, tempConfigDir, type FakeDaemon } from './helpers/fake-daemon.js';

const daemons: FakeDaemon[] = [];

afterEach(async () => {
  while (daemons.length > 0) {
    const d = daemons.pop();
    if (d !== undefined) await d.stop();
  }
});

async function daemon(): Promise<FakeDaemon> {
  const d = await startFakeDaemon();
  daemons.push(d);
  return d;
}

describe('port discovery', () => {
  it('finds the port from daemon.json', async () => {
    const d = await daemon();
    const client = new DaemonClient({ configDir: d.configDir });
    expect(client.baseUrl()).toBe(`http://127.0.0.1:${d.port}`);
    const health = (await client.get('/health')) as { ok: boolean };
    expect(health.ok).toBe(true);
  });

  it('throws DaemonUnreachable when there is no daemon.json', () => {
    const client = new DaemonClient({ configDir: tempConfigDir() });
    expect(() => client.baseUrl()).toThrow(DaemonUnreachable);
    expect(() => client.baseUrl()).toThrow(/claude-usage status/);
  });

  it('throws DaemonUnreachable when daemon.json is malformed', async () => {
    const dir = tempConfigDir();
    writeFileSync(daemonFilePath(dir), '{ port: }');
    await expect(new DaemonClient({ configDir: dir }).get('/health')).rejects.toBeInstanceOf(DaemonUnreachable);
  });

  it('prefers an explicit baseUrl and strips a trailing slash', async () => {
    const d = await daemon();
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${d.port}/` });
    expect(client.baseUrl()).toBe(`http://127.0.0.1:${d.port}`);
    expect((await client.get('/health')) as { ok: boolean }).toMatchObject({ ok: true });
  });
});

describe('requests', () => {
  it('GETs and parses JSON', async () => {
    const d = await daemon();
    const body = (await new DaemonClient({ configDir: d.configDir }).get('/v1/limits')) as { limits: unknown[] };
    expect(body.limits).toHaveLength(3);
  });

  it('POSTs with the bearer token', async () => {
    const d = await daemon();
    const client = new DaemonClient({ configDir: d.configDir, token: 'test-bearer-token' });
    const body = (await client.post('/v1/refresh')) as { limits: unknown[] };
    expect(body.limits).toHaveLength(3);
  });

  it('turns a 401 into DaemonUnreachable carrying the envelope message', async () => {
    const d = await daemon();
    const client = new DaemonClient({ configDir: d.configDir, token: 'not-the-token' });
    await expect(client.post('/v1/refresh')).rejects.toThrow(/Authorization: Bearer/);
  });

  it('turns a 404 into DaemonUnreachable', async () => {
    const d = await daemon();
    await expect(new DaemonClient({ configDir: d.configDir }).get('/nope')).rejects.toBeInstanceOf(DaemonUnreachable);
  });

  it('turns a dead port into DaemonUnreachable', async () => {
    const d = await startFakeDaemon();
    await d.stop();
    await expect(new DaemonClient({ configDir: d.configDir }).get('/health')).rejects.toBeInstanceOf(DaemonUnreachable);
  });

  it('aborts on the timeout', async () => {
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 5,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        }),
    });
    await expect(client.get('/health')).rejects.toBeInstanceOf(DaemonUnreachable);
  });

  it('defaults to a 2 s timeout', () => {
    expect(new DaemonClient({ baseUrl: 'http://x' }).timeoutMs).toBe(DEFAULT_CLIENT_TIMEOUT_MS);
  });

  it('never sends an Authorization header when no token is configured', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const client = new DaemonClient({
      baseUrl: 'http://x',
      fetchImpl: async (_url, init) => {
        seen.push(init?.headers);
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    await client.get('/health');
    expect(seen[0]).not.toHaveProperty('authorization');
  });
});

describe('isPidAlive', () => {
  it('recognises this process and rejects impossible pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});

describe('readDaemonInfo defaults', () => {
  it('tolerates a file missing startedAt and version', () => {
    const dir = tempConfigDir();
    writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: 42, port: 1234 }));
    expect(readDaemonInfo(dir)).toEqual({ pid: 42, port: 1234, startedAt: '', version: '' });
  });
});

describe('the bearer comes from config.json (§23.55)', () => {
  function capture(seen: Array<Record<string, string> | undefined>): ConstructorParameters<typeof DaemonClient>[0] {
    return {
      fetchImpl: async (_url, init) => {
        seen.push(init?.headers);
        return { ok: true, status: 200, text: async () => '{}' };
      },
    };
  }

  it('sends the token from <configDir>/config.json on GET and POST alike', async () => {
    const d = await daemon();
    const seen: Array<Record<string, string> | undefined> = [];
    const client = new DaemonClient({ configDir: d.configDir, ...capture(seen) });
    await client.get('/v1/summary');
    await client.post('/v1/sessions/register', {});
    expect(seen.map((h) => h?.['authorization'])).toEqual(['Bearer test-bearer-token', 'Bearer test-bearer-token']);
  });

  it('re-reads it per request, so a rotated token is picked up without a restart', async () => {
    const dir = tempConfigDir();
    const seen: Array<Record<string, string> | undefined> = [];
    const client = new DaemonClient({ configDir: dir, baseUrl: 'http://x', ...capture(seen) });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ auth: { token: 'first' } }));
    await client.get('/health');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ auth: { token: 'second' } }));
    await client.get('/health');
    expect(seen.map((h) => h?.['authorization'])).toEqual(['Bearer first', 'Bearer second']);
  });

  it('an explicit token wins, and an explicit empty one sends none', async () => {
    const d = await daemon();
    const seen: Array<Record<string, string> | undefined> = [];
    await new DaemonClient({ configDir: d.configDir, token: 'explicit', ...capture(seen) }).get('/health');
    await new DaemonClient({ configDir: d.configDir, token: '', ...capture(seen) }).get('/health');
    expect(seen[0]?.['authorization']).toBe('Bearer explicit');
    expect(seen[1]).not.toHaveProperty('authorization');
  });

  it('never volunteers the token to a bare baseUrl', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    await new DaemonClient({ baseUrl: 'http://x', ...capture(seen) }).get('/v1/summary');
    expect(seen[0]).not.toHaveProperty('authorization');
  });

  it('really authenticates against a daemon that refuses tokenless loopback requests', async () => {
    const d = await daemon();
    await expect(new DaemonClient({ configDir: d.configDir, token: '' }).get('/v1/summary')).rejects.toMatchObject({ status: 401 });
    expect(await new DaemonClient({ configDir: d.configDir }).get('/v1/summary')).toHaveProperty('limits');
  });

  it.each([
    ['a missing file', null],
    ['invalid JSON', '{ nope'],
    ['a non-object', '[1, 2]'],
    ['no auth section', '{"name":"x"}'],
    ['a non-string token', '{"auth":{"token":42}}'],
    ['an otherwise invalid config', '{"auth":{"token":"kept"},"thresholds":{"warn":900}}'],
  ])('readAuthToken never throws: %s', (_label, contents) => {
    const dir = tempConfigDir();
    if (contents !== null) writeFileSync(join(dir, 'config.json'), contents);
    expect(readAuthToken(dir)).toBe(contents?.includes('kept') === true ? 'kept' : '');
  });
});
