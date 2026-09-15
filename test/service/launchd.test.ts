import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LaunchdService } from '../../src/service/launchd.js';
import { buildUnit, LAUNCHD_LABEL, LOG_TRUNCATE_BYTES, ServiceError, UPDATE_RESTART_EXIT_CODE } from '../../src/service/index.js';
import { cleanupAllTempHomes, fakeExec, tempHome } from '../install/helpers.js';

afterAll(cleanupAllTempHomes);

function unit(): ReturnType<typeof buildUnit> {
  return buildUnit({
    nodePath: '/opt/node/v20/bin/node',
    binPath: '/data/claude-usage/current/bin/claude-usage',
    env: { PATH: '/opt/node/v20/bin:/usr/bin', XDG_CONFIG_HOME: '/tmp/cfg', XDG_DATA_HOME: '/tmp/data' },
  });
}

describe('plist', () => {
  it('writes the label, absolute ProgramArguments, env, RunAtLoad and KeepAlive', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());

    const plist = readFileSync(svc.unitPath, 'utf8');
    expect(svc.unitPath).toBe(join(h.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/node/v20/bin/node</string>');
    expect(plist).toContain('<string>/data/claude-usage/current/bin/claude-usage</string>');
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<key>PATH</key>\n\t\t<string>/opt/node/v20/bin:/usr/bin</string>');
    expect(plist).toContain('<key>XDG_CONFIG_HOME</key>\n\t\t<string>/tmp/cfg</string>');
    expect(plist).toContain('<key>XDG_DATA_HOME</key>\n\t\t<string>/tmp/data</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n\t<true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>');
    expect(plist).toContain(`<string>${join(h.home, 'Library', 'Logs', 'claude-usage', 'daemon.out.log')}</string>`);
    expect(plist).toContain(`<string>${join(h.home, 'Library', 'Logs', 'claude-usage', 'daemon.err.log')}</string>`);
  });

  /** Same restart contract as the systemd unit (§20, §23.9) — see that test. */
  it('keeps KeepAlive.SuccessfulExit=false, so only a non-zero exit relaunches', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    await svc.install(unit());
    const plist = readFileSync(svc.unitPath, 'utf8');

    expect(plist).toContain('<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>');
    // `KeepAlive: true` would relaunch after `configure service off`.
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\n\t<true\/>/);
    expect(plist).toContain(`exiting ${String(UPDATE_RESTART_EXIT_CODE)}`);
  });

  it('omits XDG variables that are not set', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(buildUnit({ nodePath: '/n', binPath: '/b', env: { PATH: '/usr/bin' } }));
    const plist = readFileSync(svc.unitPath, 'utf8');
    expect(plist).not.toContain('XDG_CONFIG_HOME');
    expect(plist).not.toContain('XDG_DATA_HOME');
  });

  it('escapes XML metacharacters in paths', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    await svc.install(buildUnit({ nodePath: '/n&<>/node', binPath: '/b', env: { PATH: '' } }));
    expect(readFileSync(svc.unitPath, 'utf8')).toContain('<string>/n&amp;&lt;&gt;/node</string>');
  });
});

describe('launchctl commands', () => {
  it('boots out then bootstraps on install', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());
    expect(exec.lines()).toEqual([
      `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 ${svc.unitPath}`,
      // RunAtLoad does not fire reliably when bootstrapping from a non-GUI session.
      `launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`,
    ]);
  });

  it('tolerates a bootout for a service that is not loaded', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[0] === 'bootout' ? { code: 3, stderr: 'No such process' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
  });

  it('still starts the job when bootstrap reports it already loaded', async () => {
    const h = tempHome();
    // A bootstrap failure used to abort install *after* bootout, leaving the daemon down.
    const exec = fakeExec((f, a) => (a[0] === 'bootstrap' ? { code: 5, stderr: 'Load failed' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
    expect(exec.lines().at(-1)).toBe(`launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`);
  });

  /**
   * §23.26. `launchctl bootout` returns before the job is actually gone, and anything that
   * lands in that window fails with `EALREADY` (errno 37). Observed on the Mac Studio during
   * the very install that was meant to repair it: `bootout` succeeded, the re-`bootstrap`
   * failed silently into the tolerate branch, `kickstart -k` then died with exit 37, and the
   * install aborted leaving **nothing loaded** — the daemon down and the LaunchAgent
   * unregistered. Tolerating the bootstrap is not enough when the failure is a race we can
   * simply wait out.
   */
  it('retries a bootstrap that lost the race with its own bootout', async () => {
    const h = tempHome();
    let bootstraps = 0;
    const exec = fakeExec((f, a) => {
      if (a[0] !== 'bootstrap') return undefined;
      bootstraps += 1;
      return bootstraps < 3 ? { code: 37, stderr: 'Operation already in progress' } : undefined;
    });
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
    expect(bootstraps).toBe(3);
    // And it still went on to start the job rather than stopping at the successful bootstrap.
    expect(exec.lines().at(-1)).toBe(`launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`);
  });

  it('gives up retrying rather than looping forever', async () => {
    const h = tempHome();
    let bootstraps = 0;
    const exec = fakeExec((f, a) => {
      if (a[0] !== 'bootstrap') return undefined;
      bootstraps += 1;
      return { code: 37, stderr: 'Operation already in progress' };
    });
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    // Still tolerated: a bootstrap failure must never abort an install after the bootout.
    await expect(svc.install(unit())).resolves.toBeUndefined();
    expect(bootstraps).toBeLessThanOrEqual(5);
  });

  /**
   * In a GUI session `RunAtLoad` fires on its own, so the explicit `kickstart -k` can arrive
   * while launchd is already starting the job and come back `EALREADY`. That is the job
   * starting, not failing — treating it as failure is what aborted the Studio's install.
   */
  it('accepts EALREADY from kickstart: the job is already on its way up', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) =>
      a[0] === 'kickstart' ? { code: 37, stderr: 'Operation already in progress' } : undefined,
    );
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
  });

  it('throws ServiceError when the job cannot be started at all', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[0] === 'kickstart' ? { code: 3, stderr: 'No such process' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await expect(svc.install(unit())).rejects.toBeInstanceOf(ServiceError);
  });

  it('uninstall boots out and removes the plist', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());
    exec.calls.length = 0;
    await svc.uninstall();
    expect(exec.lines()).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(existsSync(svc.unitPath)).toBe(false);
  });

  it('restart uses kickstart -k', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.restart();
    expect(exec.lines()).toEqual([`launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`]);
  });

  it('stop boots out', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.stop();
    expect(exec.lines()).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
  });
});

describe('status', () => {
  it('is not-installed without a plist', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    expect(await svc.status()).toBe('not-installed');
  });

  it('is running when launchctl print reports a pid', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[0] === 'print' ? { stdout: 'state = running\n\tpid = 4242\n' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());
    expect(await svc.status()).toBe('running');
  });

  it('is stopped when print succeeds without a pid, and when print fails', async () => {
    const h = tempHome();
    const noPid = fakeExec((f, a) => (a[0] === 'print' ? { stdout: 'state = not running\n' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: noPid.runner, uid: 501 });
    await svc.install(unit());
    expect(await svc.status()).toBe('stopped');

    const failing = fakeExec((f, a) => (a[0] === 'print' ? { code: 113 } : undefined));
    const svc2 = new LaunchdService({ env: h.env, exec: failing.runner, uid: 501 });
    expect(await svc2.status()).toBe('stopped');
  });
});

describe('logs', () => {
  it('creates the log directory 0700 and truncates logs over 10 MB at install', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    mkdirSync(svc.logDir, { recursive: true });
    writeFileSync(svc.stderrLog, 'x'.repeat(LOG_TRUNCATE_BYTES + 10));
    writeFileSync(svc.stdoutLog, 'small');

    await svc.install(unit());

    expect(statSync(svc.stderrLog).size).toBe(0);
    expect(statSync(svc.stdoutLog).size).toBe(5);
    expect(statSync(svc.logDir).mode & 0o777).toBe(0o700);
  });

  it('tails the stderr log, and returns [] when there is none', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    expect(await svc.logTail(20)).toEqual([]);
    mkdirSync(svc.logDir, { recursive: true });
    writeFileSync(svc.stderrLog, Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n') + '\n');
    const tail = await svc.logTail(20);
    expect(tail).toHaveLength(20);
    expect(tail[0]).toBe('line 10');
    expect(tail[19]).toBe('line 29');
  });
});
