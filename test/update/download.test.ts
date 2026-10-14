// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { download, downloadTo, MAX_DOWNLOAD_BYTES, makeTempDir, tmpRoot, UpdateError, SMALL_ASSET_MAX_BYTES } from '../../src/update/download.js';
import { fakeFetch, TempDirs } from './helpers.js';

const dirs = new TempDirs();
afterAll(() => {
  dirs.cleanup();
});

const RELEASE = {
  version: '0.1.418+abc',
  tarballUrl: 'https://github.example/dl/claude-usage-0.1.418+abc.tgz',
  shasumsUrl: 'https://github.example/dl/SHA256SUMS',
  signatureUrl: 'https://github.example/dl/SHA256SUMS.sig',
};

describe('download() (§20 "Integrity")', () => {
  it('writes all three assets into a temp dir under XDG_DATA_HOME/claude-usage/tmp', async () => {
    const env = dirs.env();
    const f = fakeFetch({
      [RELEASE.tarballUrl]: { body: 'tarball-bytes' },
      [RELEASE.signatureUrl]: { body: 'c2lnbmF0dXJl\n' },
      [RELEASE.shasumsUrl]: { body: 'deadbeef  claude-usage-0.1.418+abc.tgz\n' },
    });
    const got = await download(RELEASE, { fetch: f.fetch, currentVersion: '0.1.417', env });

    expect(got.dir.startsWith(tmpRoot(env))).toBe(true);
    expect(got.tarballFile).toBe('claude-usage-0.1.418+abc.tgz');
    expect(readFileSync(got.tarballPath, 'utf8')).toBe('tarball-bytes');
    expect(readFileSync(got.shasumsPath, 'utf8')).toMatch(/SHA256SUMS|deadbeef/);
    expect(got.bytes).toBe('tarball-bytes'.length);
    expect(readFileSync(got.signaturePath, 'utf8')).toBe('c2lnbmF0dXJl\n');
    expect(statSync(got.signaturePath).mode & 0o077).toBe(0);
    // §23.59: the signature and the checksums are fetched before the tarball.
    expect(f.requests.map((r) => r.url)).toEqual([RELEASE.signatureUrl, RELEASE.shasumsUrl, RELEASE.tarballUrl]);
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

  it('a release with no signature is abandoned before the tarball is even requested (§23.59)', async () => {
    const env = dirs.env();
    const f = fakeFetch({ [RELEASE.tarballUrl]: { body: 'ok' }, [RELEASE.shasumsUrl]: { body: 'x' } }); // SHA256SUMS.sig 404s
    await expect(download(RELEASE, { fetch: f.fetch, currentVersion: '0.1.417', env })).rejects.toMatchObject({ code: 'http' });
    expect(f.requests.map((r) => r.url)).toEqual([RELEASE.signatureUrl]);
    expect(readdirSync(tmpRoot(env))).toEqual([]);
  });

  it('refuses an implausibly large signature or checksum file', async () => {
    const env = dirs.env();
    const f = fakeFetch({ [RELEASE.signatureUrl]: { body: 'A'.repeat(SMALL_ASSET_MAX_BYTES + 1) } });
    await expect(download(RELEASE, { fetch: f.fetch, currentVersion: '0.1.417', env })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('cleans the temp dir up when the second asset fails', async () => {
    const env = dirs.env();
    const f = fakeFetch({ [RELEASE.tarballUrl]: { body: 'ok' }, [RELEASE.signatureUrl]: { body: 'c2ln' } }); // SHA256SUMS 404s
    await expect(download(RELEASE, { fetch: f.fetch, currentVersion: '0.1.417', env })).rejects.toBeInstanceOf(UpdateError);
    // A half-downloaded release never survives under tmp/.
    expect(readdirSync(tmpRoot(env))).toEqual([]);
  });
});
