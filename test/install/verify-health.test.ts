/**
 * §23.27: `install` exited 0 in the middle of its own verification.
 *
 * `defaultSleep` unref'd its timer. During `verifyHealth` the first probe fails fast when the
 * daemon has not finished starting (connection refused leaves no lingering handle), so the
 * retry timer was the *only* thing on the event loop — and an unref'd timer does not hold the
 * process open. Node exited 0 mid-`await`, silently, before the status table and before every
 * collected note: the §23.20/§23.25 "launchd will not supervise this" warning among them.
 *
 * Observed on the Mac Studio: three consecutive installs whose output stopped dead after
 * `mcp: registered via direct merge`, each reporting success. It only reproduces when the
 * daemon is slow enough to need a second probe, which is why a fast local machine never saw it.
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultSleep, verifyHealth, HEALTH_INTERVAL_MS, HEALTH_TIMEOUT_MS } from '../../src/install/context.js';
import type { InstallIO } from '../../src/install/context.js';

function io(overrides: Partial<InstallIO> = {}): InstallIO {
  return { stdout: () => {}, stderr: () => {}, ...overrides } as InstallIO;
}

describe('defaultSleep (§23.27)', () => {
  it('keeps the process alive while it waits', async () => {
    const real = globalThis.setTimeout;
    let captured: NodeJS.Timeout | null = null;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      captured = t;
      return t;
    }) as never);
    const pending = defaultSleep(5);
    spy.mockRestore();

    expect(captured).not.toBeNull();
    // An unref'd timer lets Node exit 0 mid-install. This is the whole bug.
    expect((captured as unknown as NodeJS.Timeout).hasRef()).toBe(true);
    await pending;
  });

  it('actually waits', async () => {
    const started = Date.now();
    await defaultSleep(25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});

describe('verifyHealth', () => {
  it('returns true on the first answer without sleeping at all', async () => {
    const sleep = vi.fn(async () => {});
    const health = vi.fn(async () => true);
    expect(await verifyHealth(io({ sleep, health }), '/tmp/cfg')).toBe(true);
    expect(health).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps probing across the retry window and reports the eventual success', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const health = vi.fn(async () => {
      calls += 1;
      return calls >= 4;
    });
    expect(await verifyHealth(io({ sleep, health }), '/tmp/cfg')).toBe(true);
    expect(health).toHaveBeenCalledTimes(4);
    // One sleep between each pair of probes, never after the last.
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(HEALTH_INTERVAL_MS);
  });

  it('gives up after the budgeted attempts rather than hanging', async () => {
    const sleep = vi.fn(async () => {});
    const health = vi.fn(async () => false);
    expect(await verifyHealth(io({ sleep, health }), '/tmp/cfg')).toBe(false);
    const attempts = Math.ceil(HEALTH_TIMEOUT_MS / HEALTH_INTERVAL_MS);
    expect(health).toHaveBeenCalledTimes(attempts);
    expect(sleep).toHaveBeenCalledTimes(attempts - 1);
  });
});
