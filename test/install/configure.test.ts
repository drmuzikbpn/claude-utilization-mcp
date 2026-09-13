import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from '../../src/install/apply.js';
import {
  firstTailscaleIPv4,
  isTailscaleIPv4,
  resolvePairingAddr,
  runConfigure,
} from '../../src/install/configure.js';
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

describe('pairing (§16)', () => {
  it('recognises the 100.64.0.0/10 range', () => {
    expect(isTailscaleIPv4('100.64.0.1')).toBe(true);
    expect(isTailscaleIPv4('100.127.255.254')).toBe(true);
    expect(isTailscaleIPv4('100.63.0.1')).toBe(false);
    expect(isTailscaleIPv4('100.128.0.1')).toBe(false);
    expect(isTailscaleIPv4('192.168.1.5')).toBe(false);
    expect(isTailscaleIPv4('not-an-ip')).toBe(false);
  });

  it('picks the first tailnet IPv4 from the interface list', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4' as const, internal: true, netmask: '', mac: '', cidr: null }],
      en0: [{ address: '192.168.1.5', family: 'IPv4' as const, internal: false, netmask: '', mac: '', cidr: null }],
      tailscale0: [{ address: '100.68.121.23', family: 'IPv4' as const, internal: false, netmask: '', mac: '', cidr: null }],
    };
    expect(firstTailscaleIPv4(ifaces)).toBe('100.68.121.23');
    expect(firstTailscaleIPv4({ lo0: ifaces.lo0 })).toBeNull();
  });

  it('falls back to `tailscale ip -4`, then to loopback with a warning', async () => {
    const viaCli = await resolvePairingAddr({
      interfaces: {},
      exec: fakeExec(() => ({ stdout: '100.70.1.2\n' })).runner,
    });
    expect(viaCli).toEqual({ addr: '100.70.1.2', warning: null });

    const none = await resolvePairingAddr({ interfaces: {}, exec: fakeExec(() => ({ code: 127 })).runner });
    expect(none.addr).toBe('127.0.0.1');
    expect(none.warning).toContain('no Tailscale address');
  });

  it('--json prints exactly { v, name, addr, port, token } and no QR', async () => {
    const b = bed();
    await runInstall(['--yes'], b.io);
    b.out = '';
    expect(await b.configure(['pairing', '--json'])).toBe(0);

    const lines = b.out.trim().split('\n');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['v', 'name', 'addr', 'port', 'token']);
    expect(payload['v']).toBe(1);
    expect(payload['port']).toBe(47291);
    expect(payload['token']).toBe('first-token');
    expect(typeof payload['addr']).toBe('string');
  });

  it('renders a QR without --json', async () => {
    const b = bed();
    await runInstall(['--yes'], b.io);
    b.out = '';
    expect(await b.configure(['pairing'])).toBe(0);
    const lines = b.out.trim().split('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ v: 1 });
  });

  it('refuses before a token exists', async () => {
    const b = bed();
    expect(await b.configure(['pairing', '--json'])).toBe(1);
    expect(b.err).toContain('rotate-token');
  });
});
