import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '../../src/config.js';
import { EventBus } from '../../src/events/bus.js';
import { currentLink, versionDir } from '../../src/paths.js';
import { repointSymlink } from '../../src/install/versions.js';
import { UPDATE_RESTART_EXIT_CODE } from '../../src/service/index.js';
import type { UpdateStatus } from '../../src/server/snapshot.js';
import {
  createUpdater,
  DEFERRED_RECHECK_MS,
  FIRST_CHECK_DELAY_MS,
  jitteredInterval,
  REASON_CONFIG_OFF,
  REASON_HARD_FROZEN,
  REASON_NOT_INSTALLED,
  type UpdaterOptions,
} from '../../src/update/index.js';
import { releasesLatestUrl } from '../../src/update/check.js';
import { currentVersion, listVersions } from '../../src/update/apply.js';
import { FakeTimers } from '../helpers/fake-timers.js';
import { fakeFetch, makeTarball, releaseJson, seedVersion, TempDirs, type FakeResponseSpec } from './helpers.js';

const dirs = new TempDirs();
afterAll(() => {
  dirs.cleanup();
});

const REPO = 'drmuzikbpn/claude-utilization-mcp';
const LATEST = releasesLatestUrl(REPO);
const CURRENT = '1.0.0+old';
const NEXT = '1.1.0+new';
const SHASUMS_URL = 'https://github.example/dl/SHA256SUMS';

function config(overrides: Partial<Config['autoUpdate']> = {}): Config {
  const c = defaultConfig();
  return { ...c, autoUpdate: { ...c.autoUpdate, repo: REPO, ...overrides } };
}

/** A temp layout with `current` → `versions/<CURRENT>`, as `install` leaves it. */
function installedEnv(): NodeJS.ProcessEnv {
  const env = dirs.env();
  const dir = seedVersion(env, CURRENT);
  repointSymlink(currentLink(env), dir);
  return env;
}

/** Routes serving a real release: the JSON, a real tarball and its real SHA256SUMS. */
function releaseRoutes(opts: { version?: string; prints?: string; corrupt?: boolean } = {}): Record<string, FakeResponseSpec> {
  const version = opts.version ?? NEXT;
  const tarball = readFileSync(makeTarball(dirs, version, opts.prints === undefined ? {} : { prints: opts.prints }));
  const digest = opts.corrupt === true ? '0'.repeat(64) : createHash('sha256').update(tarball).digest('hex');
  return {
    [LATEST]: { body: releaseJson(version), headers: { etag: 'W/"one"' } },
    [`https://github.example/dl/claude-usage-${version}.tgz`]: { body: tarball },
    [SHASUMS_URL]: { body: `${digest}  claude-usage-${version}.tgz\n` },
  };
}

interface Harness {
  updater: ReturnType<typeof createUpdater>;
  timers: FakeTimers;
  events: UpdateStatus[];
  restarts: number;
  env: NodeJS.ProcessEnv;
}

function harness(opts: Partial<UpdaterOptions> & { routes?: Record<string, FakeResponseSpec>; env?: NodeJS.ProcessEnv } = {}): Harness {
  const env = opts.env ?? installedEnv();
  const timers = new FakeTimers();
  const events: UpdateStatus[] = [];
  const bus = new EventBus();
  bus.subscribe('update', (payload) => events.push(payload as UpdateStatus));
  const state = { restarts: 0 };
  const updater = createUpdater({
    config: opts.config ?? config(),
    currentVersion: CURRENT,
    bus,
    env,
    timers,
    random: opts.random ?? ((): number => 0.5),
    fetch: fakeFetch(opts.routes ?? releaseRoutes()).fetch,
    // The layout check is the real one unless a test overrides it.
    ...(opts.packageRoot === undefined ? { packageRoot: versionDir(CURRENT, env) } : { packageRoot: opts.packageRoot }),
    ...(opts.hardFrozen === undefined ? {} : { hardFrozen: opts.hardFrozen }),
    restart:
      opts.restart ??
      ((): void => {
        state.restarts += 1;
      }),
  });
  return {
    updater,
    timers,
    events,
    env,
    get restarts() {
      return state.restarts;
    },
  };
}

/**
 * `apply()` spawns real `tar` and real `node`, so a fake-timer tick starts work that
 * finishes a few real milliseconds later. Wait for the state machine to settle.
 */
async function settle(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the updater to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('jitter (§20 "Loop")', () => {
  it('stays inside ±10 % of the interval', () => {
    expect(jitteredInterval(600_000, () => 0)).toBe(540_000);
    expect(jitteredInterval(600_000, () => 0.5)).toBe(600_000);
    expect(jitteredInterval(600_000, () => 0.999_999)).toBeLessThanOrEqual(660_000);
    for (let i = 0; i < 200; i += 1) {
      const ms = jitteredInterval(600_000, Math.random);
      expect(ms).toBeGreaterThanOrEqual(540_000);
      expect(ms).toBeLessThanOrEqual(660_000);
    }
  });
});

describe('the update loop (§20)', () => {
  it('reports idle and schedules the first check 60 s after start', () => {
    const h = harness();
    h.updater.start();
    expect(h.updater.status()).toMatchObject({ channel: 'stable', current: CURRENT, available: null, state: 'idle' });
    expect(h.updater.pendingDelayMs).toBe(FIRST_CHECK_DELAY_MS);
  });

  it('runs through checking → downloading → verifying → ready and restarts', async () => {
    const h = harness();
    h.updater.start();
    await h.timers.advance(FIRST_CHECK_DELAY_MS);
    await settle(() => h.updater.status().state === 'ready');

    expect(h.events.map((e) => e.state)).toEqual(['idle', 'checking', 'downloading', 'verifying', 'ready']);
    expect(h.updater.status()).toMatchObject({ available: NEXT, state: 'ready', deferredReason: null });
    expect(currentVersion(h.env)).toBe(NEXT);
    expect(h.restarts).toBe(1);
    // The scratch directory is gone.
    expect(readdirSync(`${String(h.env['XDG_DATA_HOME'])}/claude-usage/tmp`)).toEqual([]);
  });

  it('re-schedules with jitter after a check and keeps looping', async () => {
    const h = harness({ routes: { [LATEST]: { body: releaseJson(CURRENT) } }, random: () => 1 });
    h.updater.start();
    await h.timers.advance(FIRST_CHECK_DELAY_MS);
    expect(h.updater.status()).toMatchObject({ state: 'idle', available: null });
    expect(h.updater.pendingDelayMs).toBe(660_000); // 600 000 + 10 %
  });

  it('stop() cancels the pending check', async () => {
    const h = harness();
    h.updater.start();
    h.updater.stop();
    expect(h.updater.pendingDelayMs).toBeNull();
    await h.timers.advance(FIRST_CHECK_DELAY_MS * 10);
    expect(h.events.map((e) => e.state)).toEqual(['idle']);
  });
});

describe('deferral while a session is hard-frozen (§18.3, §20)', () => {
  it('defers instead of restarting, then proceeds once the freeze clears', async () => {
    let frozen = true;
    const h = harness({ hardFrozen: () => frozen });
    h.updater.start();
    await h.timers.advance(FIRST_CHECK_DELAY_MS);

    expect(h.updater.status()).toMatchObject({ state: 'deferred', deferredReason: REASON_HARD_FROZEN, available: NEXT });
    expect(h.restarts).toBe(0);
    expect(currentVersion(h.env)).toBe(CURRENT);
    // While deferred it re-checks every 30 s, not on the full interval.
    expect(h.updater.pendingDelayMs).toBe(DEFERRED_RECHECK_MS);

    await h.timers.advance(DEFERRED_RECHECK_MS);
    expect(h.updater.status().state).toBe('deferred');
    expect(h.restarts).toBe(0);

    frozen = false;
    await h.timers.advance(DEFERRED_RECHECK_MS);
    await settle(() => h.updater.status().state === 'ready');
    expect(h.updater.status()).toMatchObject({ state: 'ready', deferredReason: null });
    expect(currentVersion(h.env)).toBe(NEXT);
    expect(h.restarts).toBe(1);
  });
});

describe('the off switches (§20)', () => {
  it('is disabled when autoUpdate.enabled is false, and schedules nothing', () => {
    const h = harness({ config: config({ enabled: false }) });
    h.updater.start();
    expect(h.updater.status()).toMatchObject({ state: 'disabled', deferredReason: REASON_CONFIG_OFF, available: null });
    expect(h.updater.pendingDelayMs).toBeNull();
    expect(h.events).toHaveLength(1);
  });

  it('is disabled when the running binary is not under the current symlink', () => {
    const env = installedEnv();
    const h = harness({ env, packageRoot: dirs.make() });
    h.updater.start();
    expect(h.updater.status()).toMatchObject({ state: 'disabled', deferredReason: REASON_NOT_INSTALLED });
    expect(h.updater.pendingDelayMs).toBeNull();
  });

  it('runOnce does nothing while disabled, but --force still runs', async () => {
    const h = harness({ config: config({ enabled: false }) });
    expect((await h.updater.runOnce()).state).toBe('disabled');
    expect(currentVersion(h.env)).toBe(CURRENT);
    expect((await h.updater.runOnce({ force: true })).state).toBe('ready');
    expect(currentVersion(h.env)).toBe(NEXT);
  });
});

describe('failure handling (§20)', () => {
  it('a sha256 mismatch ends in error, installs nothing and deletes the download', async () => {
    const h = harness({ routes: releaseRoutes({ corrupt: true }) });
    await h.updater.runOnce();
    expect(h.updater.status()).toMatchObject({ state: 'error', available: NEXT });
    expect(currentVersion(h.env)).toBe(CURRENT);
    expect(h.restarts).toBe(0);
    expect(readdirSync(`${String(h.env['XDG_DATA_HOME'])}/claude-usage/tmp`)).toEqual([]);
    expect(existsSync(versionDir(NEXT, h.env))).toBe(false);
  });

  it('a smoke-test failure ends in error and never repoints current', async () => {
    const h = harness({ routes: releaseRoutes({ prints: 'something-else' }) });
    await h.updater.runOnce();
    expect(h.updater.status().state).toBe('error');
    expect(currentVersion(h.env)).toBe(CURRENT);
    expect(listVersions(h.env)).toEqual([CURRENT]);
    expect(h.restarts).toBe(0);
  });

  it('a failed check ends in error and the loop keeps going', async () => {
    const h = harness({ routes: { [LATEST]: { throws: 'ENOTFOUND' } } });
    h.updater.start();
    await h.timers.advance(FIRST_CHECK_DELAY_MS);
    expect(h.updater.status().state).toBe('error');
    expect(h.updater.pendingDelayMs).toBe(600_000);
  });

  it('does nothing when the latest release is not newer', async () => {
    const h = harness({ routes: { [LATEST]: { body: releaseJson('0.0.1+ancient') } } });
    const status = await h.updater.runOnce();
    expect(status).toMatchObject({ state: 'idle', available: null });
    expect(currentVersion(h.env)).toBe(CURRENT);
  });

  it('checkOnly reports the available version without touching the layout', async () => {
    const h = harness();
    await expect(h.updater.checkOnly()).resolves.toEqual({ current: CURRENT, available: NEXT, error: null });
    expect(currentVersion(h.env)).toBe(CURRENT);
    expect(h.events).toHaveLength(0);
  });

  it('a 304 re-uses the release it already knows about', async () => {
    const routes = releaseRoutes();
    let served = 0;
    const fetchSpec: Record<string, FakeResponseSpec | (() => FakeResponseSpec)> = {
      ...routes,
      [LATEST]: () => {
        served += 1;
        return served === 1 ? (routes[LATEST] as FakeResponseSpec) : { status: 304, headers: { etag: 'W/"one"' } };
      },
    };
    const env = installedEnv();
    const bus = new EventBus();
    const updater = createUpdater({
      config: config(),
      currentVersion: CURRENT,
      bus,
      env,
      packageRoot: versionDir(CURRENT, env),
      fetch: fakeFetch(fetchSpec).fetch,
      restart: (): void => {},
    });
    await expect(updater.checkOnly()).resolves.toMatchObject({ available: NEXT });
    await expect(updater.checkOnly()).resolves.toMatchObject({ available: NEXT, error: null });
    expect(served).toBe(2);
  });
});

describe('restart policy (§20, §23.9)', () => {
  it('the documented relaunch exit code is non-zero — exit 0 means "stay down"', () => {
    expect(UPDATE_RESTART_EXIT_CODE).toBe(75);
    expect(UPDATE_RESTART_EXIT_CODE).not.toBe(0);
  });
});
