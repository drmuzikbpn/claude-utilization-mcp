import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { download, downloadTo, MAX_DOWNLOAD_BYTES, makeTempDir, tmpRoot, UpdateError } from '../../src/update/download.js';
import { fakeFetch, TempDirs } from './helpers.js';

const dirs = new TempDirs();
afterAll(() => {
  dirs.cleanup();
});

const RELEASE = {
  version: '0.1.418+abc',
  tarballUrl: 'https://github.example/dl/claude-usage-0.1.418+abc.tgz',
  shasumsUrl: 'https://github.example/dl/SHA256SUMS',
};

describe('download() (§20 "Integrity")', () => {
  it('writes both assets into a temp dir under XDG_DATA_HOME/claude-usage/tmp', async () => {
    const env = dirs.env();
    const f = fakeFetch({
      [RELEASE.tarballUrl]: { body: 'tarball-bytes' },
      [RELEASE.shasumsUrl]: { body: 'deadbeef  claude-usage-0.1.418+abc.tgz\n' },
    });
    const got = await download(RELEASE, { fetch: f.fetch, currentVersion: '0.1.417', env });

    expect(got.dir.startsWith(tmpRoot(env))).toBe(true);
    expect(got.tarballFile).toBe('claude-usage-0.1.418+abc.tgz');
    expect(readFileSync(got.tarballPath, 'utf8')).toBe('tarball-bytes');
    expect(readFileSync(got.shasumsPath, 'utf8')).toMatch(/SHA256SUMS|deadbeef/);
    expect(got.bytes).toBe('tarball-bytes'.length);
    // The download is not world-readable.
    expect(statSync(got.tarballPath).mode & 0o077).toBe(0);
  });

  it.each([
    'http://github.example/dl/x.tgz',
    'file:///etc/passwd',
    'ftp://github.example/x.tgz',
    'not a url at all',
  ])('refuses %s — https only', async (url) => {
    const env = dirs.env();
    const f = fakeFetch({});
    await expect(downloadTo(url, join(makeTempDir(env), 'x'), { fetch: f.fetch, currentVersion: '0.1.417' })).rejects.toMatchObject({
      code: 'insecure_url',
    });
    // Nothing was even requested.
    expect(f.requests).toEqual([]);
  });

  it('rejects a content-length over the 50 MB cap without reading the body', async () => {
    const env = dirs.env();
    const dir = makeTempDir(env);
    const f = fakeFetch({
      [RELEASE.tarballUrl]: { body: 'small', headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } },
    });
    await expect(downloadTo(RELEASE.tarballUrl, join(dir, 'x.tgz'), { fetch: f.fetch, currentVersion: '0.1.417' })).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(f.bodyReads).toEqual([]);
    expect(existsSync(join(dir, 'x.tgz'))).toBe(false);
  });

  it('rejects a body over the cap even when content-length lied', async () => {
    const env = dirs.env();
    const dir = makeTempDir(env);
    const f = fakeFetch({ [RELEASE.tarballUrl]: { body: 'x'.repeat(64), headers: { 'content-length': '1' } } });
    await expect(
      downloadTo(RELEASE.tarballUrl, join(dir, 'x.tgz'), { fetch: f.fetch, currentVersion: '0.1.417', maxBytes: 32 }),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(existsSync(join(dir, 'x.tgz'))).toBe(false);
  });

  it('reports an HTTP failure and a network error as UpdateError', async () => {
    const env = dirs.env();
    const dir = makeTempDir(env);
    const missing = fakeFetch({});
    await expect(downloadTo(RELEASE.tarballUrl, join(dir, 'x'), { fetch: missing.fetch, currentVersion: '0.1.417' })).rejects.toMatchObject({
      code: 'http',
    });
    const broken = fakeFetch({ [RELEASE.tarballUrl]: { throws: 'socket hang up' } });
    await expect(downloadTo(RELEASE.tarballUrl, join(dir, 'x'), { fetch: broken.fetch, currentVersion: '0.1.417' })).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('cleans the temp dir up when the second asset fails', async () => {
    const env = dirs.env();
    const f = fakeFetch({ [RELEASE.tarballUrl]: { body: 'ok' } }); // SHA256SUMS 404s
    await expect(download(RELEASE, { fetch: f.fetch, currentVersion: '0.1.417', env })).rejects.toBeInstanceOf(UpdateError);
    // A half-downloaded release never survives under tmp/.
    expect(readdirSync(tmpRoot(env))).toEqual([]);
  });
});
