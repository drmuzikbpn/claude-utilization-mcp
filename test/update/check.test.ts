import { describe, expect, it } from 'vitest';
import { check, isForeignTag, releasesLatestUrl, userAgent } from '../../src/update/check.js';
import { fakeFetch, releaseJson } from './helpers.js';

const REPO = 'drmuzikbpn/claude-utilization-mcp';
const URL_LATEST = releasesLatestUrl(REPO);

describe('check() — GET /repos/<repo>/releases/latest (§20)', () => {
  it('returns the version and both asset URLs from a 200', async () => {
    const f = fakeFetch({ [URL_LATEST]: { body: releaseJson('0.1.418+abc1234'), headers: { etag: 'W/"abc"' } } });
    const result = await check({ repo: REPO, currentVersion: '0.1.417+aaa', fetch: f.fetch });
    expect(result.release).toEqual({
      version: '0.1.418+abc1234',
      tarballUrl: 'https://github.example/dl/claude-usage-0.1.418+abc1234.tgz',
      shasumsUrl: 'https://github.example/dl/SHA256SUMS',
    });
    expect(result.etag).toBe('W/"abc"');
    expect(result.error).toBeNull();
    expect(result.notModified).toBe(false);
  });

  it('sends a claude-usage User-Agent and no authorization header — the API is used anonymously', async () => {
    const f = fakeFetch({ [URL_LATEST]: { body: releaseJson('0.1.418+abc1234') } });
    await check({ repo: REPO, currentVersion: '0.1.417+aaa', fetch: f.fetch });
    const headers = f.requests[0]?.headers ?? {};
    expect(headers['user-agent']).toBe(userAgent('0.1.417+aaa'));
    expect(headers['user-agent']).toBe('claude-usage/0.1.417+aaa');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(JSON.stringify(f.requests)).not.toMatch(/gh[pous]_|token/i);
  });

  it('sends If-None-Match when it has an ETag and reports 304 as not-modified', async () => {
    const f = fakeFetch({ [URL_LATEST]: { status: 304, headers: { etag: 'W/"abc"' } } });
    const result = await check({ repo: REPO, currentVersion: '0.1.417', fetch: f.fetch, etag: 'W/"abc"' });
    expect(f.requests[0]?.headers['if-none-match']).toBe('W/"abc"');
    expect(result.notModified).toBe(true);
    expect(result.release).toBeNull();
    expect(result.error).toBeNull();
    expect(result.etag).toBe('W/"abc"');
  });

  it('reports a 404 as an http error, never a throw', async () => {
    const f = fakeFetch({});
    const result = await check({ repo: REPO, currentVersion: '0.1.417', fetch: f.fetch });
    expect(result.release).toBeNull();
    expect(result.error).toBe('http 404');
  });

  it('reports a network failure as an error, never a throw', async () => {
    const f = fakeFetch({ [URL_LATEST]: { throws: 'ENOTFOUND api.github.com' } });
    const result = await check({ repo: REPO, currentVersion: '0.1.417', fetch: f.fetch });
    expect(result.release).toBeNull();
    expect(result.error).toMatch(/network: ENOTFOUND/);
  });

  it.each([
    ['not JSON at all', 'not json', /was not JSON/],
    ['a JSON array', '[]', /was not an object/],
    ['no tag_name', JSON.stringify({ assets: [] }), /no tag_name/],
    ['no tarball asset', JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'SHA256SUMS', browser_download_url: 'https://x/y' }] }), /claude-usage-9\.9\.9\.tgz/],
    ['no SHA256SUMS', JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'claude-usage-9.9.9.tgz', browser_download_url: 'https://x/y' }] }), /SHA256SUMS/],
    ['a draft', JSON.stringify({ tag_name: 'v9.9.9', draft: true, assets: [] }), /draft or prerelease/],
  ])('reports malformed release: %s', async (_name, body, pattern) => {
    const f = fakeFetch({ [URL_LATEST]: { body } });
    const result = await check({ repo: REPO, currentVersion: '0.1.417', fetch: f.fetch });
    expect(result.release).toBeNull();
    expect(result.error).toMatch(pattern);
  });

  it('ignores a `deck-` release without reporting an error (§23.17)', async () => {
    // The Android dashboard ships its APK from this same repo. If one of its releases ever
    // lands as "latest", it is not ours — and it must not look like a broken update either,
    // because an error here would also mask the next real daemon release.
    const f = fakeFetch({
      [URL_LATEST]: {
        body: JSON.stringify({
          tag_name: 'deck-1.4.0',
          assets: [{ name: 'usage-deck.apk', browser_download_url: 'https://x/y' }],
        }),
      },
    });
    const result = await check({ repo: REPO, currentVersion: '0.1.417', fetch: f.fetch });
    expect(result.release).toBeNull();
    expect(result.error).toBeNull();
  });

  it('classifies foreign tags case-insensitively and leaves ours alone', () => {
    expect(isForeignTag('deck-1.4.0')).toBe(true);
    expect(isForeignTag('Deck-1.4.0')).toBe(true);
    expect(isForeignTag('v0.1.65+0f7f1c3')).toBe(false);
    expect(isForeignTag('0.1.65')).toBe(false);
    // Not a prefix match on a version that merely contains the word.
    expect(isForeignTag('v1.0.0-deck')).toBe(false);
  });

  it('honours a forked repo from config', async () => {
    const url = releasesLatestUrl('someone/fork');
    expect(url).toBe('https://api.github.com/repos/someone/fork/releases/latest');
    const f = fakeFetch({ [url]: { body: releaseJson('1.0.0+f00') } });
    const result = await check({ repo: 'someone/fork', currentVersion: '0.1.417', fetch: f.fetch });
    expect(result.release?.version).toBe('1.0.0+f00');
  });
});
