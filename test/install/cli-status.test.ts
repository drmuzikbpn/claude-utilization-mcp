import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, W6_LOG_TAIL } from '../../src/cli.js';
import { macLogDir } from '../../src/paths.js';
import { cleanupAllTempHomes, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

interface Result {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[], env: NodeJS.ProcessEnv, configDir: string): Promise<Result> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    configDir,
    env,
    stdin: '{}',
  });
  return { code, out, err };
}

describe('status when the daemon is down (§23.9)', () => {
  it('prints the service state after the "not running" line', async () => {
    const h = tempHome();
    mkdirSync(h.configDir, { recursive: true });
    const r = await cli(['status'], h.env, h.configDir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('daemon: not running');
    expect(r.out).toMatch(/service: (launchd|systemd|noop) — not-installed/);
  });

  it('says so when there is no captured stderr', async () => {
    const h = tempHome();
    mkdirSync(h.configDir, { recursive: true });
    const r = await cli(['status'], h.env, h.configDir);
    expect(r.out).toContain('no stderr output captured');
  });

  it.runIf(process.platform === 'darwin')('prints the last 20 stderr lines', async () => {
    const h = tempHome();
    mkdirSync(h.configDir, { recursive: true });
    const logDir = macLogDir(h.env);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, 'daemon.err.log'),
      `${Array.from({ length: 40 }, (_, i) => `daemon line ${String(i)}`).join('\n')}\n`,
    );

    const r = await cli(['status'], h.env, h.configDir);
    expect(r.out).toContain(`log: last ${String(W6_LOG_TAIL)} stderr lines`);
    expect(r.out).toContain('daemon line 39');
    expect(r.out).toContain('daemon line 20');
    expect(r.out).not.toContain('daemon line 19');
  });

  it('does not run the diagnostics when the daemon is up', async () => {
    const { startFakeDaemon } = await import('../helpers/fake-daemon.js');
    const d = await startFakeDaemon();
    try {
      const r = await cli(['status'], {}, d.configDir);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('service:');
    } finally {
      await d.stop();
    }
  });
});

describe('help', () => {
  it('lists install, configure and uninstall as real commands', async () => {
    const h = tempHome();
    const r = await cli(['help'], h.env, h.configDir);
    expect(r.out).toContain('install [--yes]');
    expect(r.out).toContain('configure');
    expect(r.out).toContain('uninstall [--purge]');
    expect(r.out).not.toMatch(/Not implemented yet:.*\binstall\b/);
  });
});
