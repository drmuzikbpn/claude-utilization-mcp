import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { currentLink, versionDir, versionsDir } from '../../src/paths.js';
import {
  apply,
  currentVersion,
  extractTarball,
  listVersions,
  pruneVersions,
  rollback,
  runningUnderCurrent,
  smokeTest,
} from '../../src/update/apply.js';
import { repointSymlink } from '../../src/install/versions.js';
import { fakeExec, makeTarball as buildTarball, seedVersion, TempDirs } from './helpers.js';

const dirs = new TempDirs();
const makeTarball = (version: string, opts: { prints?: string } = {}): string => buildTarball(dirs, version, opts);
afterAll(() => {
  dirs.cleanup();
});

describe('extractTarball', () => {
  it('strips the package/ root dir', async () => {
    const dest = join(dirs.make(), 'out');
    await extractTarball(makeTarball('1.2.3+aaa'), dest);
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
    expect(existsSync(join(dest, 'package', 'package.json'))).toBe(false);
    expect(existsSync(join(dest, 'bin', 'claude-usage'))).toBe(true);
  });

  it('reports a tar failure as extract_failed', async () => {
    const bad = join(dirs.make(), 'not-a-tarball.tgz');
    writeFileSync(bad, 'definitely not gzip');
    await expect(extractTarball(bad, join(dirs.make(), 'out'))).rejects.toMatchObject({ code: 'extract_failed' });
  });
});

describe('smokeTest (§20)', () => {
  it('passes when the extracted build prints the expected version', async () => {
    const dest = join(dirs.make(), 'out');
    await extractTarball(makeTarball('1.2.3+aaa'), dest);
    await expect(smokeTest(dest, '1.2.3+aaa')).resolves.toBeUndefined();
  });

  it('fails when it prints a different version', async () => {
    const dest = join(dirs.make(), 'out');
    await extractTarball(makeTarball('1.2.3+aaa', { prints: '0.0.1' }), dest);
    await expect(smokeTest(dest, '1.2.3+aaa')).rejects.toMatchObject({ code: 'smoke_failed' });
  });

  it('accepts a core-only version when the release tag carries +build (real CI shape)', async () => {
    const dest = join(dirs.make(), 'out');
    // CI stamps package.json with the core; the release tag has +sha.
    await extractTarball(makeTarball('0.1.64', { prints: '0.1.64' }), dest);
    await expect(smokeTest(dest, '0.1.64+bb7fc6f')).resolves.toBeUndefined();
  });

  it('fails when the binary exits non-zero', async () => {
    const f = fakeExec(() => ({ code: 1, stderr: 'boom' }));
    await expect(smokeTest('/nowhere', '1.2.3', { exec: f.exec, nodePath: '/usr/bin/node' })).rejects.toMatchObject({
      code: 'smoke_failed',
    });
    expect(f.calls[0]).toEqual({ file: '/usr/bin/node', args: ['/nowhere/bin/claude-usage', '--version'] });
  });
});

describe('apply() (§20)', () => {
  it('extracts into versions/<v>, repoints current and reports the previous version', async () => {
    const env = dirs.env();
    seedVersion(env, '1.0.0+old');
    repointSymlink(currentLink(env), versionDir('1.0.0+old', env));

    const result = await apply({ version: '1.2.3+new', tarballPath: makeTarball('1.2.3+new'), env });

    expect(result.versionDir).toBe(versionDir('1.2.3+new', env));
    expect(result.previousVersion).toBe('1.0.0+old');
    expect(currentVersion(env)).toBe('1.2.3+new');
    expect(realpathSync(currentLink(env))).toBe(realpathSync(versionDir('1.2.3+new', env)));
    expect(JSON.parse(readFileSync(join(currentLink(env), 'package.json'), 'utf8'))).toMatchObject({ version: '1.2.3+new' });
  });

  it('a failed smoke test leaves current alone and installs nothing', async () => {
    const env = dirs.env();
    seedVersion(env, '1.0.0+old');
    repointSymlink(currentLink(env), versionDir('1.0.0+old', env));

    await expect(
      apply({ version: '1.2.3+new', tarballPath: makeTarball('1.2.3+new', { prints: 'wrong' }), env }),
    ).rejects.toMatchObject({ code: 'smoke_failed' });

    expect(currentVersion(env)).toBe('1.0.0+old');
    expect(existsSync(versionDir('1.2.3+new', env))).toBe(false);
    // No staging directory survives either.
    expect(listVersions(env)).toEqual(['1.0.0+old']);
  });

  it('prunes to the current version plus the newest two previous ones', async () => {
    const env = dirs.env();
    for (const v of ['0.9.1+a', '0.9.2+b', '0.9.3+c', '0.9.4+d']) seedVersion(env, v);
    repointSymlink(currentLink(env), versionDir('0.9.4+d', env));

    const result = await apply({ version: '1.0.0+new', tarballPath: makeTarball('1.0.0+new'), env });

    expect(result.pruned.sort()).toEqual(['0.9.1+a', '0.9.2+b']);
    expect(listVersions(env)).toEqual(['1.0.0+new', '0.9.4+d', '0.9.3+c']);
  });

  it('prune keeps whatever current points at, even when it is not the newest', () => {
    const env = dirs.env();
    for (const v of ['1.0.0+a', '1.1.0+b', '1.2.0+c', '1.3.0+d']) seedVersion(env, v);
    repointSymlink(currentLink(env), versionDir('1.0.0+a', env));
    const removed = pruneVersions(env);
    expect(removed).toEqual(['1.1.0+b']);
    expect(listVersions(env).sort()).toEqual(['1.0.0+a', '1.2.0+c', '1.3.0+d']);
  });
});

describe('rollback() (§20)', () => {
  it('repoints current at the next-newest installed version', () => {
    const env = dirs.env();
    for (const v of ['1.0.0+a', '1.1.0+b', '1.2.0+c']) seedVersion(env, v);
    repointSymlink(currentLink(env), versionDir('1.2.0+c', env));

    expect(rollback(env)).toMatchObject({ from: '1.2.0+c', to: '1.1.0+b' });
    expect(currentVersion(env)).toBe('1.1.0+b');
    // Rolling back again walks further down the list.
    expect(rollback(env)).toMatchObject({ from: '1.1.0+b', to: '1.0.0+a' });
  });

  it('refuses when there is nothing older installed', () => {
    const env = dirs.env();
    seedVersion(env, '1.0.0+a');
    repointSymlink(currentLink(env), versionDir('1.0.0+a', env));
    expect(() => rollback(env)).toThrow(/no previous version/);
  });

  it('skips a version directory with no binary in it', () => {
    const env = dirs.env();
    seedVersion(env, '1.0.0+a');
    mkdirSync(versionDir('1.1.0+broken', env), { recursive: true });
    seedVersion(env, '1.2.0+c');
    repointSymlink(currentLink(env), versionDir('1.2.0+c', env));
    expect(rollback(env)).toMatchObject({ to: '1.0.0+a' });
  });
});

describe('layout introspection', () => {
  it('currentVersion is null without a link, and listVersions is empty without a layout', () => {
    const env = dirs.env();
    expect(currentVersion(env)).toBeNull();
    expect(listVersions(env)).toEqual([]);
    mkdirSync(versionsDir(env), { recursive: true });
    expect(listVersions(env)).toEqual([]);
  });

  it('runningUnderCurrent only agrees when the package root is the current link', () => {
    const env = dirs.env();
    const dir = seedVersion(env, '1.0.0+a');
    seedVersion(env, '1.1.0+b');
    repointSymlink(currentLink(env), dir);
    expect(runningUnderCurrent(dir, env)).toBe(true);
    expect(runningUnderCurrent(versionDir('1.1.0+b', env), env)).toBe(false);
    expect(runningUnderCurrent('/definitely/not/here', env)).toBe(false);
  });
});
