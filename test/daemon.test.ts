import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { configPath, defaultConfig, saveConfig } from '../src/config.js';
import { daemonFilePath, readDaemonInfo } from '../src/clients/http.js';
import { PortInUseError, serve, startDaemon, type DaemonHandle } from '../src/daemon.js';
import { FakeTokensSource } from './helpers/fakes.js';
import { tempConfigDir } from './helpers/fake-daemon.js';

const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.stop();
  }
});

async function start(configDir: string, over: Parameters<typeof startDaemon>[0] = {}): Promise<DaemonHandle> {
  const h = await startDaemon({
    configDir,
    port: 0,
    poll: false,
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    log: () => undefined,
    ...over,
  });
  handles.push(h);
  return h;
}

describe('daemon lifecycle', () => {
  it('writes daemon.json 0600 with pid, port, startedAt and version', async () => {
    const dir = tempConfigDir();
    const h = await start(dir);
    const file = daemonFilePath(dir);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const info = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(info['pid']).toBe(process.pid);
    expect(info['port']).toBe(h.port);
    expect(info['version']).toBe('9.9.9');
    expect(String(info['startedAt'])).toMatch(/Z$/);
  });

  it('creates the config dir 0700 when it does not exist', async () => {
    const dir = `${tempConfigDir()}/nested/claude-usage`;
    await start(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('serves /health on the bound port', async () => {
    const h = await start(tempConfigDir());
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }).version).toBe('9.9.9');
  });

  it('removes daemon.json on stop', async () => {
    const dir = tempConfigDir();
    const h = await start(dir);
    await h.stop();
    expect(existsSync(daemonFilePath(dir))).toBe(false);
  });

  it('is idempotent on repeated stop', async () => {
    const h = await start(tempConfigDir());
    await h.stop();
    await expect(h.stop()).resolves.toBeUndefined();
  });

  it('loads config from the config dir', async () => {
    const dir = tempConfigDir();
    const cfg = defaultConfig();
    cfg.name = 'configured-host';
    cfg.thresholds = { warn: 50, critical: 70 };
    saveConfig(cfg, dir);
    const h = await start(dir);
    expect(h.config.name).toBe('configured-host');
    const summary = (await (await fetch(`http://127.0.0.1:${h.port}/v1/summary`)).json()) as {
      thresholds: unknown;
    };
    expect(summary.thresholds).toMatchObject({ warn: 50, critical: 70 });
  });

  it('reports an invalid config by key rather than starting', async () => {
    const dir = tempConfigDir();
    writeFileSync(configPath(dir), JSON.stringify({ thresholds: { warn: 900 } }));
    await expect(startDaemon({ configDir: dir, port: 0, poll: false, log: () => undefined })).rejects.toThrow(
      /thresholds\.warn/,
    );
  });

  it('throws PortInUseError when the port is taken', async () => {
    const dir = tempConfigDir();
    const first = await start(dir);
    await expect(
      startDaemon({ configDir: tempConfigDir(), port: first.port, poll: false, log: () => undefined }),
    ).rejects.toBeInstanceOf(PortInUseError);
  });

  it('attaches a tokens source built by createTokensSource', async () => {
    const dir = tempConfigDir();
    const tokens = new FakeTokensSource({ stats: { filesTracked: 77 } });
    const h = await startDaemon({
      configDir: dir,
      port: 0,
      poll: false,
      version: '9.9.9',
      log: () => undefined,
      createTokensSource: async () => tokens,
    });
    handles.push(h);
    const health = (await (await fetch(`http://127.0.0.1:${h.port}/health`)).json()) as {
      stats: { filesTracked: number; spendReady: boolean };
    };
    expect(health.stats.filesTracked).toBe(77);
    expect(health.stats.spendReady).toBe(true);
  });

  it('still serves with no tokens source at all', async () => {
    const h = await startDaemon({
      configDir: tempConfigDir(),
      port: 0,
      poll: false,
      version: '9.9.9',
      log: () => undefined,
      createTokensSource: async () => null,
    });
    handles.push(h);
    const tokens = (await (await fetch(`http://127.0.0.1:${h.port}/v1/tokens`)).json()) as { ready: boolean };
    expect(tokens.ready).toBe(false);
  });

  it('serves /v1/limits before the first poll completes', async () => {
    const h = await start(tempConfigDir());
    const body = (await (await fetch(`http://127.0.0.1:${h.port}/v1/limits`)).json()) as { fetchedAt: null };
    expect(body.fetchedAt).toBeNull();
  });
});

describe('readDaemonInfo', () => {
  it('reads what startDaemon wrote', async () => {
    const dir = tempConfigDir();
    const h = await start(dir);
    expect(readDaemonInfo(dir)).toMatchObject({ pid: process.pid, port: h.port, version: '9.9.9' });
  });

  it('returns null for a missing, malformed or portless file', () => {
    const dir = tempConfigDir();
    expect(readDaemonInfo(dir)).toBeNull();
    writeFileSync(daemonFilePath(dir), 'not json');
    expect(readDaemonInfo(dir)).toBeNull();
    writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: 1 }));
    expect(readDaemonInfo(dir)).toBeNull();
  });
});

describe('serve', () => {
  it('returns exit code 1 with a message when the port is in use', async () => {
    const dir = tempConfigDir();
    const first = await start(dir);
    const lines: string[] = [];
    const code = await serve({
      configDir: tempConfigDir(),
      port: first.port,
      poll: false,
      tokens: null,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/already in use/);
  });

  it('returns exit code 1 when config is invalid', async () => {
    const dir = tempConfigDir();
    writeFileSync(configPath(dir), JSON.stringify({ port: 'nope' }));
    const lines: string[] = [];
    const code = await serve({ configDir: dir, poll: false, tokens: null, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/port/);
  });

  it('shuts down on SIGTERM, removing daemon.json, and exits 0', async () => {
    const dir = tempConfigDir();
    const lines: string[] = [];
    const promise = serve({ configDir: dir, port: 0, poll: false, tokens: null, log: (l) => lines.push(l) });
    // Wait until daemon.json exists, then signal ourselves.
    for (let i = 0; i < 100 && !existsSync(daemonFilePath(dir)); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(daemonFilePath(dir))).toBe(true);
    process.emit('SIGTERM', 'SIGTERM');
    expect(await promise).toBe(0);
    expect(existsSync(daemonFilePath(dir))).toBe(false);
    expect(lines.join('\n')).toMatch(/SIGTERM received/);
  });
});
