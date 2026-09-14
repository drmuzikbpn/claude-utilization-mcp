/**
 * §23.18: the updater's restart must not depend on the supervisor noticing an exit code.
 *
 * The Mac Studio's launchd job was bootstrapped over SSH, which leaves it in a `gui/<uid>`
 * domain whose spawns stay `pended nondemand spawn = speculative`. `KeepAlive` never fires
 * there — a `kill -9` on a job up well past `minimum runtime` left it down indefinitely —
 * so a daemon that updated itself never came back.
 */
import { describe, expect, it, vi } from 'vitest';
import { RESTART_GRACE_MS } from '../../src/update/index.js';

describe('restart policy (§23.18)', () => {
  it('exposes a grace window long enough for the supervisor to act', () => {
    expect(RESTART_GRACE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it('asks the service manager to restart before falling back to the exit code', async () => {
    const restart = vi.fn(async () => {});
    vi.doMock('../../src/service/index.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/service/index.js')>();
      return { ...actual, createServiceManager: async () => ({ kind: 'launchd', restart }) };
    });
    vi.resetModules();
    const { defaultRestart } = await import('../../src/update/index.js');

    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);
    try {
      await expect(defaultRestart({}, 1)).rejects.toThrow('exit:75');
      // The request came first: a bare exit is what failed on the Studio.
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
      vi.doUnmock('../../src/service/index.js');
      vi.resetModules();
    }
  });

  it('still exits 75 when there is no service manager', async () => {
    vi.doMock('../../src/service/index.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/service/index.js')>();
      return { ...actual, createServiceManager: async () => ({ kind: 'noop', restart: async () => {} }) };
    });
    vi.resetModules();
    const { defaultRestart } = await import('../../src/update/index.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);
    try {
      await expect(defaultRestart({}, 1)).rejects.toThrow('exit:75');
    } finally {
      exit.mockRestore();
      vi.doUnmock('../../src/service/index.js');
      vi.resetModules();
    }
  });

  it('falls back to the exit when the restart request throws', async () => {
    vi.doMock('../../src/service/index.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/service/index.js')>();
      return {
        ...actual,
        createServiceManager: async () => ({
          kind: 'launchd',
          restart: async () => {
            throw new Error('launchctl: Could not find domain');
          },
        }),
      };
    });
    vi.resetModules();
    const { defaultRestart } = await import('../../src/update/index.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);
    try {
      await expect(defaultRestart({}, 1)).rejects.toThrow('exit:75');
    } finally {
      exit.mockRestore();
      vi.doUnmock('../../src/service/index.js');
      vi.resetModules();
    }
  });
});
