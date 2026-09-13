import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';
import { saveConfig, defaultConfig } from '../../src/config.js';
import { currentLink, versionDir } from '../../src/paths.js';
import { repointSymlink } from '../../src/install/versions.js';
import { currentVersion } from '../../src/update/apply.js';
import { releasesLatestUrl } from '../../src/update/check.js';
import { createUpdater } from '../../src/update/index.js';
import { fakeFetch, makeTarball, releaseJson, seedVersion, TempDirs, type FakeResponseSpec } from './helpers.js';

const dirs = new TempDirs();
afterAll(() => {
  dirs.cleanup();
});

const REPO = 'drmuzikbpn/claude-utilization-mcp';
const LATEST = releasesLatestUrl(REPO);
const CURRENT = '1.0.0+old';
const NEXT = '1.1.0+new';

interface Ctx {
  env: NodeJS.ProcessEnv;
  configDir: string;
  out: string[];
  err: string[];
  restarts: string[];
  io: Parameters<typeof run>[1];
}

function ctx(opts: { routes?: Record<string, FakeResponseSpec>; versions?: string[] } = {}): Ctx {
  const env = dirs.env();
  const configDir = dirs.make('claude-usage-cfg-');
  const c = defaultConfig();
  saveConfig({ ...c, autoUpdate: { ...c.autoUpdate, repo: REPO } }, configDir);
  for (const v of opts.versions ?? [CURRENT]) seedVersion(env, v);
  repointSymlink(currentLink(env), versionDir(opts.versions?.[opts.versions.length - 1] ?? CURRENT, env));

  const out: string[] = [];
  const err: string[] = [];
  const restarts: string[] = [];
  const updater = createUpdater({
    config: { ...c, autoUpdate: { ...c.autoUpdate, repo: REPO } },
    currentVersion: CURRENT,
    env,
    packageRoot: null,
    fetch: fakeFetch(opts.routes ?? {}).fetch,
    restart: (): void => {},
  });
  return {
    env,
    configDir,
    out,
    err,
    restarts,
    io: {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
      configDir,
      env,
      // The CLI restarts the service rather than exiting; the fake records it.
      restartService: () => {
        restarts.push('restarted');
        return Promise.resolve('service: restarted (fake)');
      },
      updater,
    } as Parameters<typeof run>[1],
  };
}

/** Routes serving a real release built in-test. */
function routes(version = NEXT): Record<string, FakeResponseSpec> {
  const tarball = readFileSync(makeTarball(dirs, version));
  const digest = createHash('sha256').update(tarball).digest('hex');
  return {
    [LATEST]: { body: releaseJson(version) },
    [`https://github.example/dl/claude-usage-${version}.tgz`]: { body: tarball },
    ['https://github.example/dl/SHA256SUMS']: { body: `${digest}  claude-usage-${version}.tgz\n` },
  };
}

describe('claude-usage update (§20)', () => {
  it('--check prints current and available without installing anything', async () => {
    const c = ctx({ routes: routes() });
    expect(await run(['update', '--check'], c.io)).toBe(0);
    expect(c.out.join('')).toContain(`current:   ${CURRENT}`);
    expect(c.out.join('')).toContain(`available: ${NEXT}`);
    expect(currentVersion(c.env)).toBe(CURRENT);
    expect(c.restarts).toEqual([]);
  });

  it('--check says so when there is nothing newer', async () => {
    const c = ctx({ routes: { [LATEST]: { body: releaseJson('0.0.1+ancient') } } });
    expect(await run(['update', '--check'], c.io)).toBe(0);
    expect(c.out.join('')).toContain('available: none — up to date');
  });

  it('--check exits 1 and says why when the check fails', async () => {
    const c = ctx({ routes: { [LATEST]: { throws: 'ENOTFOUND api.github.com' } } });
    expect(await run(['update', '--check'], c.io)).toBe(1);
    expect(c.err.join('')).toMatch(/check failed: network/);
  });

  it('installs the release, repoints current and restarts the service', async () => {
    const c = ctx({ routes: routes() });
    expect(await run(['update'], c.io)).toBe(0);
    expect(currentVersion(c.env)).toBe(NEXT);
    expect(c.out.join('')).toContain('state:     ready');
    expect(c.out.join('')).toContain(`installed: ${NEXT}`);
    expect(c.restarts).toEqual(['restarted']);
  });

  it('exits 1 without restarting when the download does not verify', async () => {
    const bad = routes();
    bad['https://github.example/dl/SHA256SUMS'] = { body: `${'0'.repeat(64)}  claude-usage-${NEXT}.tgz\n` };
    const c = ctx({ routes: bad });
    expect(await run(['update'], c.io)).toBe(1);
    expect(c.out.join('')).toContain('state:     error');
    expect(currentVersion(c.env)).toBe(CURRENT);
    expect(c.restarts).toEqual([]);
  });
});

describe('claude-usage rollback (§20)', () => {
  it('repoints current at the previous version and restarts', async () => {
    const c = ctx({ versions: ['1.0.0+a', '1.1.0+b'] });
    expect(await run(['rollback'], c.io)).toBe(0);
    expect(c.out.join('')).toContain('rolled back: 1.1.0+b → 1.0.0+a');
    expect(currentVersion(c.env)).toBe('1.0.0+a');
    expect(c.restarts).toEqual(['restarted']);
  });

  it('exits 1 and lists what is installed when there is nothing to roll back to', async () => {
    const c = ctx({ versions: ['1.0.0+a'] });
    expect(await run(['rollback'], c.io)).toBe(1);
    expect(c.err.join('')).toMatch(/no previous version/);
    expect(c.err.join('')).toContain('installed versions: 1.0.0+a');
    expect(c.restarts).toEqual([]);
  });
});

describe('help', () => {
  it('lists update and rollback', async () => {
    const out: string[] = [];
    await run(['help'], { stdout: (t) => out.push(t) });
    expect(out.join('')).toMatch(/^\s+update \[--check\]/m);
    expect(out.join('')).toMatch(/^\s+rollback\s+/m);
    expect(out.join('')).not.toMatch(/Not implemented yet:.*update/);
  });
});
