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

function service(result: ExecResult): LaunchdService {
  return new LaunchdService({
    env: { HOME: '/tmp/cu-home' },
    exec: async () => result,
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
});
