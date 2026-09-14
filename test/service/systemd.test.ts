import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SystemdService } from '../../src/service/systemd.js';
import { buildUnit, ServiceError, SYSTEMD_UNIT, UPDATE_RESTART_EXIT_CODE } from '../../src/service/index.js';
import { NoopService } from '../../src/service/noop.js';
import { createServiceManager } from '../../src/service/index.js';
import { cleanupAllTempHomes, fakeExec, tempHome } from '../install/helpers.js';

afterAll(cleanupAllTempHomes);

function unit(): ReturnType<typeof buildUnit> {
  return buildUnit({
    nodePath: '/usr/local/bin/node',
    binPath: '/data/claude-usage/current/bin/claude-usage',
    env: { PATH: '/usr/local/bin:/usr/bin', XDG_DATA_HOME: '/data' },
  });
}

describe('unit file', () => {
  it('has an absolute ExecStart, Environment=PATH, Restart=on-failure and WantedBy=default.target', async () => {
    const h = tempHome();
    const svc = new SystemdService({ env: h.env, exec: fakeExec().runner });
    await svc.install(unit());

    expect(svc.unitPath).toBe(join(h.home, '.config', 'systemd', 'user', 'claude-usage.service'));
    const text = readFileSync(svc.unitPath, 'utf8');
    expect(text).toContain(
      'ExecStart=/usr/local/bin/node /data/claude-usage/current/bin/claude-usage serve',
    );
    expect(text).toContain('Environment=PATH=/usr/local/bin:/usr/bin');
    expect(text).toContain('Environment=XDG_DATA_HOME=/data');
    expect(text).toContain('Restart=on-failure');
    expect(text).toContain('[Install]\nWantedBy=default.target');
  });

  /**
   * §20 vs §23.9: §20 assumed a clean `exit(0)` would be relaunched, but
   * `Restart=on-failure` does not restart on exit 0 — and neither does launchd's
   * `KeepAlive: { SuccessfulExit: false }`. §23.9 wins, so the unit keeps
   * on-failure and the updater exits non-zero instead.
   */
  it('keeps Restart=on-failure — exit 0 stops the service, the updater exits non-zero', async () => {
    const h = tempHome();
    const svc = new SystemdService({ env: h.env, exec: fakeExec().runner });
    await svc.install(unit());
    const text = readFileSync(svc.unitPath, 'utf8');

    expect(text).toContain('Restart=on-failure');
    expect(text).not.toContain('Restart=always');
    // Nothing may declare the updater's exit code a success, or it would never restart.
    expect(text).not.toMatch(/^SuccessExitStatus=/m);
    // The policy is documented in the unit itself, naming the exit code.
    expect(text).toContain(`# ${String(UPDATE_RESTART_EXIT_CODE)} (EX_TEMPFAIL)`);
    expect(UPDATE_RESTART_EXIT_CODE).not.toBe(0);
  });
});

describe('systemctl commands', () => {
  it('reloads then enables --now on install', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.install(unit());
    expect(exec.lines()).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
    ]);
  });

  it('disables --now, deletes the unit and reloads on uninstall — and never touches linger', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.install(unit());
    exec.calls.length = 0;
    await svc.uninstall();
    expect(exec.lines()).toEqual([
      `systemctl --user disable --now ${SYSTEMD_UNIT}`,
      'systemctl --user daemon-reload',
    ]);
    expect(exec.lines().join(' ')).not.toContain('linger');
    expect(existsSync(svc.unitPath)).toBe(false);
  });

  it('restart reloads then restarts (configure port rewrites the unit first)', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.restart();
    expect(exec.lines()).toEqual(['systemctl --user daemon-reload', `systemctl --user restart ${SYSTEMD_UNIT}`]);
  });

  it('throws ServiceError when enable fails', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[1] === 'enable' ? { code: 1, stderr: 'Failed' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await expect(svc.install(unit())).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('status and logs', () => {
  it('is not-installed without a unit file, running when is-active says active', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[1] === 'is-active' ? { stdout: 'active\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.status()).toBe('not-installed');
    await svc.install(unit());
    expect(await svc.status()).toBe('running');
  });

  it('is stopped when is-active says inactive', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[1] === 'is-active' ? { code: 3, stdout: 'inactive\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.install(unit());
    expect(await svc.status()).toBe('stopped');
  });

  it('tails the journal', async () => {
    const h = tempHome();
    const exec = fakeExec((f) => (f === 'journalctl' ? { stdout: 'a\nb\nc\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.logTail(20)).toEqual(['a', 'b', 'c']);
    expect(exec.lines()).toContain('journalctl --user -u claude-usage -n 20 --no-pager -q');
  });

  it('returns no lines when journalctl is unavailable', async () => {
    const h = tempHome();
    const exec = fakeExec(() => ({ code: 127 }));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.logTail(20)).toEqual([]);
  });

  it('drops journalctl banner lines that would read as captured output', async () => {
    const h = tempHome();
    const exec = fakeExec((f) => (f === 'journalctl' ? { stdout: '-- No entries --\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.logTail(20)).toEqual([]);
  });
});

describe('linger', () => {
  it('reports success', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.enableLinger()).toEqual({ ok: true, message: 'lingering enabled for testuser' });
    expect(exec.lines()).toEqual(['loginctl enable-linger testuser']);
  });

  it('reports — never throws — when loginctl is missing or fails', async () => {
    const h = tempHome();
    const missing = new SystemdService({ env: h.env, exec: fakeExec(() => ({ code: 127 })).runner });
    const r1 = await missing.enableLinger();
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain('loginctl not found');

    const failing = new SystemdService({
      env: h.env,
      exec: fakeExec(() => ({ code: 1, stderr: 'Access denied\n' })).runner,
    });
    const r2 = await failing.enableLinger();
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('Access denied');
  });
});

describe('createServiceManager', () => {
  it('picks launchd on darwin, systemd on linux and noop elsewhere', async () => {
    const h = tempHome();
    expect((await createServiceManager({ platform: 'darwin', env: h.env })).kind).toBe('launchd');
    expect((await createServiceManager({ platform: 'linux', env: h.env })).kind).toBe('systemd');
    expect((await createServiceManager({ platform: 'win32', env: h.env })).kind).toBe('noop');
  });
});

describe('noop', () => {
  it('does nothing and reports not-installed', async () => {
    const svc = new NoopService();
    await svc.install();
    await svc.start();
    await svc.stop();
    await svc.restart();
    await svc.uninstall();
    expect(await svc.status()).toBe('not-installed');
    expect(await svc.logTail()).toEqual([]);
    expect(svc.unitPath).toBe('');
  });
});
