// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from '../../src/install/apply.js';
import { defaultConfig, saveConfig } from '../../src/config.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import { adoptRotatedToken, PAIRING_REMOVED, runConfigure } from '../../src/install/configure.js';
import type { InstallIO } from '../../src/install/context.js';
import { MCP_KEY } from '../../src/install/claude-json.js';
import { hookCommand } from '../../src/install/settings-merge.js';
import { claudeJsonPath, currentBin, settingsPath } from '../../src/paths.js';
import { cleanupAllTempHomes, fakeExec, fakePackage, FakeService, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'install');

interface Bed {
  env: NodeJS.ProcessEnv;
  configDir: string;
  service: FakeService;
  exec: ReturnType<typeof fakeExec>;
  out: string;
  err: string;
  io: InstallIO;
  configure(argv: string[]): Promise<number>;
}

function bed(opts: { settings?: 'settings-empty.json' | 'settings-populated.json'; exec?: ReturnType<typeof fakeExec> } = {}): Bed {
  const h = tempHome();
  if (opts.settings !== undefined) {
    const file = settingsPath(h.env);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(FIXTURES, opts.settings), file);
  }
  const service = new FakeService();
  const exec = opts.exec ?? fakeExec(() => ({ code: 127 }));
  const b: Bed = {
    env: h.env,
    configDir: h.configDir,
    service,
    exec,
    out: '',
    err: '',
    io: {} as InstallIO,
    configure: async () => 0,
  };
  b.io = {
    stdout: (t) => {
      b.out += t;
    },
    stderr: (t) => {
      b.err += t;
    },
    env: h.env,
    platform: 'darwin',
    service,
    exec: exec.runner,
    nodePath: '/usr/bin/node',
    sourceDir: fakePackage('1.2.3'),
    version: '1.2.3',
    readCredentials: () => Promise.resolve('x'),
    health: () => Promise.resolve(true),
    sleep: () => Promise.resolve(),
    randomToken: () => 'first-token',
    isTTY: false,
  };
  b.configure = (argv) => runConfigure(argv, b.io);
  return b;
}

function config(b: Bed): Record<string, never> {
  return JSON.parse(readFileSync(join(b.configDir, 'config.json'), 'utf8')) as Record<string, never>;
}

function settings(b: Bed): string {
  return readFileSync(settingsPath(b.env), 'utf8');
}

describe('toggles reverse install', () => {
  it('hook off removes exactly our groups; hook on puts them back', async () => {
    const b = bed({ settings: 'settings-populated.json' });
    const original = readFileSync(join(FIXTURES, 'settings-populated.json'), 'utf8');
    await runInstall(['--yes'], b.io);
    const installed = settings(b);

    expect(await b.configure(['hook', 'off'])).toBe(0);
    expect(settings(b)).toBe(original);
    expect((config(b)['integrations'] as unknown as Record<string, boolean>)['hook']).toBe(false);

    expect(await b.configure(['hook', 'on'])).toBe(0);
    expect(settings(b)).toBe(installed);
    expect((config(b)['integrations'] as unknown as Record<string, boolean>)['hook']).toBe(true);
  });

  it('statusline on/off only touches our own statusLine', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    await b.configure(['statusline', 'on']);
    expect(settings(b)).toContain(`${currentBin(b.env)} statusline`);
    await b.configure(['statusline', 'off']);
    expect(settings(b)).not.toContain('statusLine');
    // our hook groups survive the statusline toggle
    expect(settings(b)).toContain(hookCommand(currentBin(b.env)));
  });

  it('mcp off removes the entry, mcp on adds it back', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    expect(readFileSync(claudeJsonPath(b.env), 'utf8')).toContain(MCP_KEY);
    await b.configure(['mcp', 'off']);
    expect(existsSync(claudeJsonPath(b.env)) ? readFileSync(claudeJsonPath(b.env), 'utf8') : '').not.toContain(MCP_KEY);
    await b.configure(['mcp', 'on']);
    expect(readFileSync(claudeJsonPath(b.env), 'utf8')).toContain(MCP_KEY);
  });

  it('service off stops and removes the unit; service on installs it', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    b.service.calls.length = 0;

    await b.configure(['service', 'off']);
    expect(b.service.calls).toEqual(['stop', 'uninstall']);
    expect((config(b)['integrations'] as unknown as Record<string, boolean>)['service']).toBe(false);

    b.service.calls.length = 0;
    await b.configure(['service', 'on']);
    expect(b.service.calls).toEqual(['install']);
    expect((config(b)['integrations'] as unknown as Record<string, boolean>)['service']).toBe(true);
  });

  it('autoupdate off/on flips only the config flag', async () => {
    const b = bed();
    await b.configure(['autoupdate', 'off']);
    expect((config(b)['autoUpdate'] as unknown as Record<string, boolean>)['enabled']).toBe(false);
    await b.configure(['autoupdate', 'on']);
    expect((config(b)['autoUpdate'] as unknown as Record<string, boolean>)['enabled']).toBe(true);
  });

  it('rejects a missing or bogus on/off', async () => {
    const b = bed();
    expect(await b.configure(['hook'])).toBe(1);
    expect(await b.configure(['hook', 'maybe'])).toBe(1);
    expect(b.err).toContain('expected "on" or "off"');
  });
});

describe('scalar settings', () => {
  it('thresholds --warn/--critical', async () => {
    const b = bed();
    expect(await b.configure(['thresholds', '--warn', '70', '--critical', '85'])).toBe(0);
    expect(config(b)['thresholds']).toEqual({ warn: 70, critical: 85 });
  });

  it('refuses warn above critical', async () => {
    const b = bed();
    expect(await b.configure(['thresholds', '--warn', '99', '--critical', '50'])).toBe(1);
    expect(b.err).toContain('must not exceed');
  });

  it('needs at least one threshold flag', async () => {
    const b = bed();
    expect(await b.configure(['thresholds'])).toBe(1);
  });

  it('port rewrites the unit and restarts when the service is on', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    b.service.calls.length = 0;
    expect(await b.configure(['port', '50000'])).toBe(0);
    expect(config(b)['port']).toBe(50_000);
    expect(b.service.calls).toEqual(['install', 'restart']);
  });

  it('port leaves the service alone when it is off', async () => {
    const b = bed();
    await b.configure(['service', 'off']);
    b.service.calls.length = 0;
    await b.configure(['port', '50001']);
    expect(b.service.calls).toEqual([]);
  });

  it('lan on/off edits bind and restarts the service only after saving (§23.44)', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    const seen: unknown[] = [];
    b.service.calls.length = 0;
    const restart = b.service.restart.bind(b.service);
    b.service.restart = async () => {
      seen.push(config(b)['bind']);
      await restart();
    };
    expect(await b.configure(['lan', 'on'])).toBe(0);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'lan']);
    expect(seen).toEqual([['127.0.0.1', 'lan']]);
    expect(b.out).toContain('lan on');

    expect(await b.configure(['lan', 'on'])).toBe(0);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'lan']);

    expect(await b.configure(['lan', 'off'])).toBe(0);
    expect(config(b)['bind']).toEqual(['127.0.0.1']);
    // The idempotent second `on` changed nothing, so it did not restart.
    expect(seen).toEqual([['127.0.0.1', 'lan'], ['127.0.0.1']]);
  });

  it('lan on leaves the service alone when it is off', async () => {
    const b = bed();
    await b.configure(['service', 'off']);
    b.service.calls.length = 0;
    expect(await b.configure(['lan', 'on'])).toBe(0);
    expect(b.service.calls).toEqual([]);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'lan']);
  });

  it('port restarts the service only after the new port is saved', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    const seen: unknown[] = [];
    const restart = b.service.restart.bind(b.service);
    b.service.restart = async () => {
      seen.push(config(b)['port']);
      await restart();
    };
    await b.configure(['port', '50003']);
    expect(seen).toEqual([50_003]);
  });

  it('refuses a port that collides with tls.port, and writes nothing', async () => {
    const b = bed();
    await b.configure(['port', '47291']);
    expect(await b.configure(['port', '65535'])).toBe(1);
    expect(b.err).toContain('tls.port');
    expect(config(b)['port']).toBe(47_291);
  });

  it('rejects a bad port', async () => {
    const b = bed();
    expect(await b.configure(['port', 'nope'])).toBe(1);
    expect(await b.configure(['port', '99999'])).toBe(1);
  });

  it('rotate-token replaces the token and keeps the file 0600', async () => {
    const b = bed();
    await b.configure(['autoupdate', 'on']);
    const first = (config(b) as unknown as { auth: { token: string } }).auth.token;
    b.io.randomToken = () => 'second-token';
    expect(await b.configure(['rotate-token'])).toBe(0);
    const second = (config(b) as unknown as { auth: { token: string } }).auth.token;
    expect(second).toBe('second-token');
    expect(second).not.toBe(first);
    expect(statSync(join(b.configDir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(b.out).toContain('re-pair every device');
  });

  it('rotate-token restarts the service, so the running daemon stops accepting the old token', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    b.service.calls.length = 0;
    b.io.randomToken = () => 'rotated-token';
    expect(await b.configure(['rotate-token'])).toBe(0);
    expect(b.service.calls).toEqual(['restart']);
  });

  it('rejects an unknown setting', async () => {
    const b = bed();
    expect(await b.configure(['frobnicate', 'on'])).toBe(1);
    expect(b.err).toContain('unknown setting "frobnicate"');
  });
});

describe('interactive menu', () => {
  it('walks the toggles and the numeric settings', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);

    const asked: string[] = [];
    // service, hook, mcp, statusline, autoupdate
    const answers = [true, false, true, true, true];
    let i = 0;
    b.io.prompt = async (question) => {
      asked.push(question);
      const a = answers[i];
      i += 1;
      return a ?? false;
    };
    const texts: Record<string, string> = { 'port': '50002', 'warn threshold %': '70' };
    b.io.ask = async (question, def) => {
      asked.push(question);
      return texts[question] ?? def;
    };

    expect(await b.configure([])).toBe(0);
    expect(asked.slice(0, 5)).toEqual(['service?', 'hook?', 'mcp?', 'statusline?', 'autoupdate?']);
    expect(asked).toContain('poll interval (ms)');
    expect(asked).toContain('hook debounce (minutes)');

    const cfg = config(b) as unknown as { integrations: Record<string, boolean>; port: number; thresholds: { warn: number } };
    expect(cfg.integrations).toMatchObject({ service: true, hook: false, mcp: true, statusline: true });
    expect(cfg.port).toBe(50_002);
    expect(cfg.thresholds.warn).toBe(70);
  });

  it('refuses without a terminal', async () => {
    const b = bed();
    expect(await b.configure([])).toBe(1);
    expect(b.err).toContain('needs a terminal');
  });
});

describe('`configure pairing` is gone (§23.57)', () => {
  it.each([[['pairing']], [['pairing', '--json']], [['pairing', '--json', '--addr', '192.0.2.42']]])(
    '%j prints nothing on stdout, points at `claude-usage pair`, and exits 1',
    async (argv) => {
      const b = bed();
      await runInstall(['--yes'], b.io);
      b.out = '';
      b.err = '';
      expect(await b.configure(argv)).toBe(1);
      expect(b.out).toBe('');
      expect(b.err).toBe(PAIRING_REMOVED);
      expect(b.err).toContain('claude-usage pair');
      // The whole point: the bearer never reaches a terminal or a QR code again.
      expect(b.out + b.err).not.toContain('first-token');
      expect(existsSync(join(b.configDir, 'pairing.json'))).toBe(false);
    },
  );

  it('is no longer offered by the usage text', async () => {
    const b = bed();
    await b.configure(['frobnicate']);
    expect(b.err).not.toContain('pairing');
  });
});

describe('rotate-token reaches a daemon nobody supervises (§23.58)', () => {
  async function rotate(b: Bed, adopt: NonNullable<InstallIO['adoptToken']>): Promise<number> {
    await b.configure(['service', 'off']);
    b.out = '';
    b.io.randomToken = () => 'rotated-token';
    b.io.adoptToken = adopt;
    return b.configure(['rotate-token']);
  }

  it('signals the running daemon and says it took the new token', async () => {
    const b = bed();
    const dirs: string[] = [];
    const code = await rotate(b, async (dir) => {
      dirs.push(dir);
      // The new token is on disk before the daemon is asked to read it.
      expect((config(b) as unknown as { auth: { token: string } }).auth.token).toBe('rotated-token');
      return { state: 'adopted', pid: 4242 };
    });
    expect(code).toBe(0);
    expect(dirs).toEqual([b.configDir]);
    expect(b.out).toContain('pid 4242');
    expect(b.out).toContain('taken the new token');
    expect(b.service.calls).not.toContain('restart');
  });

  it('exits non-zero and says plainly that the old token still works when the daemon did not take it', async () => {
    const b = bed();
    const code = await rotate(b, async () => ({ state: 'failed', pid: 4242, why: 'it did not answer to the new token' }));
    expect(code).toBe(1);
    expect(b.err).toContain('STILL ACCEPTING THE OLD TOKEN');
    expect(b.err).toContain('pid 4242');
    expect(b.err).toContain('Stop it and start it again');
    // The new token is saved all the same: the next start uses it.
    expect((config(b) as unknown as { auth: { token: string } }).auth.token).toBe('rotated-token');
    expect(b.out + b.err).not.toContain('rotated-token');
  });

  it('is quiet when no daemon is running', async () => {
    const b = bed();
    expect(await rotate(b, async () => ({ state: 'no-daemon' }))).toBe(0);
    expect(b.err).toBe('');
  });

  it('leaves a supervised daemon to the service restart', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await runInstall(['--yes'], b.io);
    let asked = false;
    b.io.adoptToken = async () => {
      asked = true;
      return { state: 'no-daemon' };
    };
    b.service.calls.length = 0;
    expect(await b.configure(['rotate-token'])).toBe(0);
    expect(b.service.calls).toEqual(['restart']);
    expect(asked).toBe(false);
  });
});

describe('adoptRotatedToken against a real daemon (§23.58)', () => {
  const handles: DaemonHandle[] = [];
  afterAll(async () => {
    for (const h of handles.splice(0)) await h.stop();
  });

  async function daemonWithToken(token: string): Promise<DaemonHandle> {
    const dir = tempHome().configDir;
    saveConfig({ ...defaultConfig(), auth: { token } }, dir);
    const h = await startDaemon({ configDir: dir, port: 0, poll: false, sessions: false, tokens: null, updater: null, log: () => undefined });
    handles.push(h);
    return h;
  }
  const status = async (h: DaemonHandle, token: string): Promise<number> =>
    (await fetch(`http://127.0.0.1:${String(h.port)}/v1/config`, { headers: { authorization: `Bearer ${token}` } })).status;

  it('no daemon.json means there is nothing to do', async () => {
    expect(await adoptRotatedToken(tempHome().configDir)).toEqual({ state: 'no-daemon' });
  });

  it('after SIGHUP the daemon answers to the new token and refuses the old one', async () => {
    const h = await daemonWithToken('old-token-old-token');
    expect(await status(h, 'old-token-old-token')).toBe(200);
    saveConfig({ ...defaultConfig(), auth: { token: 'new-token-new-token' } }, h.configDir);
    // Not signalled yet: the daemon still holds the old token in memory.
    expect(await status(h, 'new-token-new-token')).toBe(401);

    const signals: Array<[number, string]> = [];
    const outcome = await adoptRotatedToken(h.configDir, {
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        void h.reload(); // what `serve` does on SIGHUP
      },
    });
    expect(signals).toEqual([[process.pid, 'SIGHUP']]);
    expect(outcome).toEqual({ state: 'adopted', pid: process.pid });
    expect(await status(h, 'new-token-new-token')).toBe(200);
    expect(await status(h, 'old-token-old-token')).toBe(401);
  });

  it('reports failure when the daemon ignores the signal', async () => {
    const h = await daemonWithToken('old-token-old-token');
    saveConfig({ ...defaultConfig(), auth: { token: 'new-token-new-token' } }, h.configDir);
    const outcome = await adoptRotatedToken(h.configDir, { kill: () => undefined, timeoutMs: 150, sleep: async () => undefined });
    expect(outcome).toMatchObject({ state: 'failed', pid: process.pid });
    expect(await status(h, 'old-token-old-token')).toBe(200);
  });

  it('reports failure when the daemon cannot be signalled at all', async () => {
    const h = await daemonWithToken('old-token-old-token');
    const outcome = await adoptRotatedToken(h.configDir, {
      kill: () => {
        throw Object.assign(new Error('nope'), { code: 'EPERM' });
      },
    });
    expect(outcome).toMatchObject({ state: 'failed', why: expect.stringContaining('EPERM') as string });
  });

  it('a reload drops the event streams that were opened with the old token', async () => {
    const h = await daemonWithToken('old-token-old-token');
    const res = await fetch(`http://127.0.0.1:${String(h.port)}/v1/events`, { headers: { authorization: 'Bearer old-token-old-token' } });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader?.read();
    expect(h.server.events.clientCount).toBe(1);
    saveConfig({ ...defaultConfig(), auth: { token: 'new-token-new-token' } }, h.configDir);
    await h.reload();
    expect(h.server.events.clientCount).toBe(0);
    await reader?.cancel().catch(() => undefined);
  });
});
