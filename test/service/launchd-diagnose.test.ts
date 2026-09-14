/**
 * §23.20: an install from a non-GUI session yields a job launchd will not restart.
 *
 * Observed on the Mac Studio, which was installed over ssh: `launchctl print` reports
 * `pended nondemand spawn = speculative` with `runs = 0` despite `runatload`, and a `kill -9`
 * on a job up well past `minimum runtime = 10` left it down indefinitely. The same job
 * installed locally on a second Mac showed `runs = 8` and came straight back. `kickstart`
 * works either way, which is exactly why the fault hides behind every manual fix.
 */
import { describe, expect, it } from 'vitest';
import { LaunchdService } from '../../src/service/launchd.js';
import type { ExecResult } from '../../src/service/index.js';

const PENDED = `gui/501/com.github.drmuzikbpn.claude-usage = {
	state = not running
	runs = 0
	pended nondemand spawn = speculative
	properties = runatload | inferred program
}`;

const HEALTHY = `gui/501/com.github.drmuzikbpn.claude-usage = {
	state = running
	pid = 32293
	runs = 8
	properties = runatload | inferred program
}`;

/**
 * `launchctl print` output plus the session `launchctl managername` reports. Two calls, so
 * the fake dispatches on the subcommand; `managername` defaults to the GUI session because
 * that is the case where a warning must come from `print` alone.
 */
function service(result: ExecResult, manager = 'Aqua'): LaunchdService {
  return new LaunchdService({
    env: { HOME: '/tmp/cu-home' },
    exec: async (_file, args) =>
      args[0] === 'managername' ? { code: 0, stdout: `${manager}\n`, stderr: '' } : result,
  });
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

describe('LaunchdService.diagnose (§23.20)', () => {
  it('warns when launchd has only pended the spawn', async () => {
    const warnings = await service(ok(PENDED)).diagnose();
    expect(warnings).toHaveLength(1);
    // The warning has to say the thing that is actually at stake, not just "ssh".
    expect(warnings[0]).toMatch(/will NOT bring it back after a crash/);
    expect(warnings[0]).toMatch(/claude-usage install/);
  });

  it('says nothing about a job launchd is really supervising', async () => {
    expect(await service(ok(HEALTHY)).diagnose()).toEqual([]);
  });

  it('stays quiet when the job is not loaded at all — that is not this problem', async () => {
    expect(await service({ code: 113, stdout: '', stderr: 'Could not find service' }).diagnose()).toEqual([]);
  });

  it('never throws, so a broken launchctl cannot fail an install', async () => {
    const svc = new LaunchdService({
      env: { HOME: '/tmp/cu-home' },
      exec: async () => {
        throw new Error('launchctl vanished');
      },
    });
    await expect(svc.diagnose()).resolves.toEqual([]);
  });

  /**
   * The regression that made the original §23.20 check unreachable.
   *
   * `pended nondemand spawn` is only printed while the job is **not running**. `install()`
   * ends with `kickstart -k`, so by the time `apply.ts` calls `diagnose()` the job is always
   * up and the line is always absent — the warning could never fire from an install, which is
   * the only thing that calls it. Verified on the Mac Studio: zero matches while running,
   * `pended nondemand spawn = semaphore` twenty seconds after a `kill -9`, and the daemon
   * still down sixty seconds later with `runs` frozen. The session type is the signal that
   * is readable at install time.
   */
  it('warns on a non-GUI install even though the running job prints clean', async () => {
    const warnings = await service(ok(HEALTHY), 'Background').diagnose();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/will NOT bring it back after a crash/);
    // Name the session, so the report says which machine state produced it.
    expect(warnings[0]).toMatch(/Background/);
  });

  it('stays quiet for a healthy job installed from the GUI session', async () => {
    expect(await service(ok(HEALTHY), 'Aqua').diagnose()).toEqual([]);
  });

  it('reports the fault once when both signals are present', async () => {
    expect(await service(ok(PENDED), 'Background').diagnose()).toHaveLength(1);
  });

  it('says nothing when the session type cannot be read', async () => {
    const svc = new LaunchdService({
      env: { HOME: '/tmp/cu-home' },
      exec: async (_file, args) =>
        args[0] === 'managername'
          ? { code: 1, stdout: '', stderr: 'unknown' }
          : { code: 0, stdout: HEALTHY, stderr: '' },
    });
    expect(await svc.diagnose()).toEqual([]);
  });
});
