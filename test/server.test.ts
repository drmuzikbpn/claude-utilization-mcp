import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerOptions, type UsageServer } from '../src/server/index.js';
import { EmptyLimitsProvider, FakeLimitsProvider, FakeTokensSource, snapshotWithPercents, testConfig } from './helpers/fakes.js';
import { rawJson, rawRequest } from './helpers/raw-request.js';

const TOKEN = 'test-bearer-token';
const started: UsageServer[] = [];

interface Started {
  server: UsageServer;
  port: number;
  url: (p: string) => string;
}

async function start(over: Partial<ServerOptions> = {}): Promise<Started> {
  const server = createServer({
    config: testConfig(),
    limits: new FakeLimitsProvider(),
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    ...over,
  });
  started.push(server);
  const port = await server.listen(0, '127.0.0.1');
  return { server, port, url: (p) => `http://127.0.0.1:${port}${p}` };
}

afterEach(async () => {
  while (started.length > 0) {
    const s = started.pop();
    if (s !== undefined) await s.close();
  }
});

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('listen', () => {
  it('returns the actual bound port when given 0', async () => {
    const { port, server } = await start();
    expect(port).toBeGreaterThan(0);
    expect(server.addresses[0]).toMatchObject({ port });
  });

  it('rejects when the port is already in use', async () => {
    const first = await start();
    const second = createServer({ config: testConfig(), limits: new FakeLimitsProvider() });
    started.push(second);
    await expect(second.listen(first.port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('GET /health', () => {
  it('answers the §4 + §15 shape', async () => {
    const { url } = await start();
    const res = await fetch(url('/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const b = await body(res);
    expect(b['ok']).toBe(true);
    expect(b['name']).toBe('test-host');
    expect(b['version']).toBe('9.9.9');
    expect(b['pid']).toBe(process.pid);
    expect(typeof b['uptimeMs']).toBe('number');
    expect(b['update']).toEqual({
      channel: 'stable',
      current: '9.9.9',
      available: null,
      state: 'disabled',
      deferredReason: null,
    });
    expect(b['stats']).toMatchObject({
      filesTracked: 12,
      eventsIndexed: 5400,
      parseErrors: 0,
      lastScanAt: '2026-09-13T13:59:00.000Z',
      spendReady: true,
    });
  });

  it('sends no CORS headers', async () => {
    const { url } = await start();
    const res = await fetch(url('/health'));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('reports user from ~/.claude.json oauthAccount', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-claudejson-'));
    const path = join(dir, '.claude.json');
    writeFileSync(
      path,
      JSON.stringify({
        oauthAccount: {
          emailAddress: 'someone@example.com',
          accountUuid: 'uuid-a',
          organizationUuid: 'uuid-o',
          displayName: 'Someone',
          organizationName: 'Org',
        },
        other: 1,
      }),
    );
    const { url } = await start({ claudeJsonPath: path });
    const b = await body(await fetch(url('/health')));
    expect(b['user']).toEqual({
      emailAddress: 'someone@example.com',
      accountUuid: 'uuid-a',
      organizationUuid: 'uuid-o',
      displayName: 'Someone',
      organizationName: 'Org',
    });
  });

  it('reports user null when ~/.claude.json is missing', async () => {
    const { url } = await start({ claudeJsonPath: '/nope/.claude.json' });
    expect((await body(await fetch(url('/health'))))['user']).toBeNull();
  });

  it('reports spendReady false with no tokens source', async () => {
    const { url } = await start({ tokens: null });
    expect((await body(await fetch(url('/health'))))['stats']).toMatchObject({ spendReady: false, filesTracked: 0 });
  });
});

describe('GET /v1/limits', () => {
  it('serves the snapshot including raw', async () => {
    const { url } = await start();
    const b = await body(await fetch(url('/v1/limits')));
    expect(b['stale']).toBe(false);
    expect(b['error']).toBeNull();
    expect((b['limits'] as unknown[]).map((l) => (l as { id: string }).id)).toEqual([
      'session',
      'weekly_all',
      'weekly_scoped:fable',
    ]);
    expect(b['raw']).toBeTruthy();
    expect(b['legacyWindows']).toHaveProperty('five_hour');
  });

  it('serves an empty snapshot before the first fetch', async () => {
    const { url } = await start({ limits: new EmptyLimitsProvider() });
    const b = await body(await fetch(url('/v1/limits')));
    expect(b).toMatchObject({ fetchedAt: null, stale: false, error: null, limits: [] });
  });
});

describe('GET /v1/summary', () => {
  it('carries limits minus raw, status, thresholds and today', async () => {
    const { url } = await start();
    const b = await body(await fetch(url('/v1/summary')));
    const limits = b['limits'] as Record<string, unknown>;
    expect(limits).not.toHaveProperty('raw');
    expect((limits['limits'] as unknown[]).length).toBe(3);
    expect(b['status']).toEqual({
      byId: { session: 'ok', weekly_all: 'ok', 'weekly_scoped:fable': 'ok' },
      overall: 'ok',
    });
    expect(b['thresholds']).toEqual({ warn: 80, critical: 95 });
    expect(b['today']).toMatchObject({ ready: true, input: 0, messages: 0 });
  });

  it('computes warn and critical from percent', async () => {
    const limits = new FakeLimitsProvider(snapshotWithPercents({ session: 84 }));
    const { url } = await start({ limits });
    let b = await body(await fetch(url('/v1/summary')));
    expect((b['status'] as { overall: string }).overall).toBe('warn');

    limits.set(snapshotWithPercents({ session: 96 }));
    b = await body(await fetch(url('/v1/summary')));
    expect((b['status'] as { overall: string }).overall).toBe('critical');
  });

  it('reports today ready:false with no tokens source', async () => {
    const { url } = await start({ tokens: null });
    expect((await body(await fetch(url('/v1/summary'))))['today']).toEqual({
      ready: false,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      messages: 0,
    });
  });

  it('reports today ready:false while the initial scan runs', async () => {
    const { url } = await start({ tokens: new FakeTokensSource({ ready: false }) });
    expect((await body(await fetch(url('/v1/summary'))))['today']).toMatchObject({ ready: false, messages: 0 });
  });
});

describe('GET /v1/tokens', () => {
  it('defaults to since=today, groupBy=project', async () => {
    const tokens = new FakeTokensSource({ totals: { input: 10, messages: 2 } });
    const { url } = await start({ tokens });
    const b = await body(await fetch(url('/v1/tokens')));
    expect(b['groupBy']).toBe('project');
    expect(b['ready']).toBe(true);
    expect(b['totals']).toMatchObject({ input: 10, messages: 2 });
    expect(tokens.queries[0]?.groupBy).toBe('project');
    expect(tokens.queries[0]?.since).toMatch(/Z$/);
  });

  it.each(['project', 'session', 'model', 'day'])('accepts groupBy=%s', async (groupBy) => {
    const { url } = await start();
    const res = await fetch(url(`/v1/tokens?groupBy=${groupBy}`));
    expect(res.status).toBe(200);
    expect((await body(res))['groupBy']).toBe(groupBy);
  });

  it.each(['7d', '24h', '2026-09-01T00:00:00Z', 'all'])('accepts since=%s', async (since) => {
    const { url } = await start();
    const res = await fetch(url(`/v1/tokens?since=${encodeURIComponent(since)}`));
    expect(res.status).toBe(200);
  });

  it('answers 400 naming a bad groupBy', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/tokens?groupBy=galaxy'));
    expect(res.status).toBe(400);
    const b = await body(res);
    expect((b['error'] as { code: string }).code).toBe('bad_request');
    expect((b['error'] as { message: string }).message).toContain('groupBy');
  });

  it('answers 400 for repeated groupBy values', async () => {
    const { url } = await start();
    expect((await fetch(url('/v1/tokens?groupBy=day&groupBy=model'))).status).toBe(400);
  });

  it('answers 400 naming a bad since', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/tokens?since=yesterdayish'));
    expect(res.status).toBe(400);
    expect(((await body(res))['error'] as { message: string }).message).toContain('since');
  });

  it('answers ready:false with no tokens source', async () => {
    const { url } = await start({ tokens: null });
    const b = await body(await fetch(url('/v1/tokens')));
    expect(b).toMatchObject({ ready: false, groupBy: 'project', groups: [] });
    expect(b['totals']).toEqual({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0 });
  });

  it('passes ready:false through from the store', async () => {
    const { url } = await start({ tokens: new FakeTokensSource({ ready: false }) });
    expect((await body(await fetch(url('/v1/tokens'))))['ready']).toBe(false);
  });
});

describe('POST /v1/refresh', () => {
  it('requires the bearer token even from loopback', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/refresh'), { method: 'POST' });
    expect(res.status).toBe(401);
    expect(((await body(res))['error'] as { code: string }).code).toBe('unauthorized');
  });

  it('returns the new limits body with a valid token', async () => {
    const limits = new FakeLimitsProvider();
    const { url } = await start({ limits });
    const res = await fetch(url('/v1/refresh'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(limits.refreshCalls).toBe(1);
    expect((await body(res))['limits']).toHaveLength(3);
  });

  it('answers 429 when rate-limited', async () => {
    const limits = new FakeLimitsProvider();
    limits.rateLimited = true;
    const { url } = await start({ limits });
    const res = await fetch(url('/v1/refresh'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(429);
    expect(((await body(res))['error'] as { code: string }).code).toBe('rate_limited');
  });

  it('rejects a wrong token', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/refresh'), {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token-entirely' },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/config', () => {
  it('redacts the bearer token', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/config'));
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const b = JSON.parse(text) as { auth: { token: string }; port: number };
    expect(b.auth.token).toBe('<redacted>');
    expect(b.port).toBe(47291);
  });
});

describe('routing', () => {
  it('answers 404 for an unknown path', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/nope'));
    expect(res.status).toBe(404);
    expect(((await body(res))['error'] as { code: string }).code).toBe('not_found');
  });

  it('answers 405 with an Allow header for a wrong method', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/limits'), { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('GET');
    expect(((await body(res))['error'] as { code: string }).code).toBe('method_not_allowed');
  });

  it('answers 405 for GET on the refresh route', async () => {
    const { url } = await start();
    const res = await fetch(url('/v1/refresh'));
    expect(res.status).toBe(405);
  });

  it('answers HEAD on safe routes', async () => {
    const { url } = await start();
    expect((await fetch(url('/health'), { method: 'HEAD' })).status).toBe(200);
  });

  it('ignores a trailing slash', async () => {
    const { url } = await start();
    expect((await fetch(url('/v1/limits/'))).status).toBe(200);
  });
});

describe('Host allowlist', () => {
  it('accepts the bound address and localhost', async () => {
    const { port } = await start();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost', '127.0.0.1']) {
      const res = await rawRequest({ port, path: '/health', headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it('answers 421 for a foreign Host', async () => {
    const { port } = await start();
    const res = await rawJson({ port, path: '/health', headers: { host: 'evil.example.com' } });
    expect(res.status).toBe(421);
    expect((res.json['error'] as { code: string }).code).toBe('misdirected_request');
  });

  it('answers 421 for a right name on a wrong port', async () => {
    const { port } = await start();
    expect((await rawRequest({ port, path: '/health', headers: { host: 'localhost:1' } })).status).toBe(421);
  });

  it('answers 421 when the Host header is absent', async () => {
    const { port } = await start();
    expect((await rawRequest({ port, path: '/health', headers: { host: '' } })).status).toBe(421);
  });

  it('accepts a configured extra host name', async () => {
    const { port } = await start({ extraHostNames: ['alans-mbp.tailnet.ts.net'] });
    const res = await rawRequest({ port, path: '/health', headers: { host: 'alans-mbp.tailnet.ts.net' } });
    expect(res.status).toBe(200);
  });
});

describe('Origin rejection', () => {
  it('answers 403 for any request carrying an Origin header', async () => {
    const { url } = await start();
    const res = await fetch(url('/health'), { headers: { origin: 'http://evil.example.com' } });
    expect(res.status).toBe(403);
    expect(((await body(res))['error'] as { code: string }).code).toBe('forbidden');
  });

  it('answers 403 even for a same-origin Origin and even with a valid token', async () => {
    const { url, port } = await start();
    const res = await fetch(url('/v1/refresh'), {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('checks Host before Origin', async () => {
    const { port } = await start();
    const res = await rawRequest({
      port,
      path: '/health',
      headers: { host: 'evil.example.com', origin: 'http://evil.example.com' },
    });
    expect(res.status).toBe(421);
  });
});

describe('auth', () => {
  it('exempts loopback GET and HEAD', async () => {
    const { url } = await start();
    for (const path of ['/health', '/v1/limits', '/v1/summary', '/v1/tokens', '/v1/config']) {
      expect((await fetch(url(path))).status, path).toBe(200);
    }
  });

  it('accepts a valid token on a safe method too', async () => {
    const { url } = await start();
    expect((await fetch(url('/health'), { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('rejects a malformed Authorization header on a mutating request', async () => {
    const { url } = await start();
    for (const authorization of ['', 'Basic abc', 'Bearer', `Token ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const res = await fetch(url('/v1/refresh'), { method: 'POST', headers: { authorization } });
      expect(res.status, authorization).toBe(401);
    }
  });

  it('never matches when no token is configured', async () => {
    const { url } = await start({ config: testConfig({ auth: { token: '' } }) });
    expect((await fetch(url('/v1/refresh'), { method: 'POST', headers: { authorization: 'Bearer ' } })).status).toBe(401);
    expect((await fetch(url('/health'))).status).toBe(200);
  });
});
