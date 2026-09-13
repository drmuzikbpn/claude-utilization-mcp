import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { createServer, type UsageServer } from '../../src/server/index.js';
import { buildHostPolicy, checkRequest } from '../../src/server/middleware.js';
import { FakeLimitsProvider, FakeTokensSource, testConfig } from '../helpers/fakes.js';
import { rawJson, rawRequest } from '../helpers/raw-request.js';

const TOKEN = 'test-bearer-token';
const MAGIC_DNS = 'alans-mbp.tail1234.ts.net';
const started: UsageServer[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const s = started.pop();
    if (s !== undefined) await s.close();
  }
});

/** `127.0.0.2` is not configured on macOS; `::1` is the portable second loopback. */
async function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => {
      probe.close(() => resolve(true));
    });
  });
}

const HAS_IPV6 = await ipv6LoopbackAvailable();

function make(extraHostNames: readonly string[] = []): UsageServer {
  const server = createServer({
    config: testConfig(),
    limits: new FakeLimitsProvider(),
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    extraHostNames,
  });
  started.push(server);
  return server;
}

describe('listen with several addresses', () => {
  it('binds one server per address, all reflected in addresses', async () => {
    const server = make();
    const port = await server.listen(0, ['127.0.0.1', ...(HAS_IPV6 ? ['::1'] : [])]);
    expect(port).toBeGreaterThan(0);
    expect(server.servers).toHaveLength(HAS_IPV6 ? 2 : 1);
    const addresses = server.addresses.map((a) => a.address);
    expect(addresses).toContain('127.0.0.1');
    expect(server.addresses.every((a) => a.port === port)).toBe(true);
    if (HAS_IPV6) expect(addresses).toContain('::1');
  });

  it('serves the same handler on every address', async () => {
    const server = make();
    const port = await server.listen(0, ['127.0.0.1', ...(HAS_IPV6 ? ['::1'] : [])]);

    const v4 = await rawJson({ port, path: '/health' });
    expect(v4.status).toBe(200);
    expect(v4.json['version']).toBe('9.9.9');

    if (HAS_IPV6) {
      const v6 = await rawJson({ port, host: '::1', path: '/health', headers: { host: `[::1]:${port}` } });
      expect(v6.status).toBe(200);
      expect(v6.json['version']).toBe('9.9.9');
    }
  });

  it.runIf(HAS_IPV6)('treats the IPv6 loopback as loopback: GET needs no token, POST does', async () => {
    const server = make();
    const port = await server.listen(0, ['127.0.0.1', '::1']);
    const headers = { host: `[::1]:${port}` };

    const get = await rawRequest({ port, host: '::1', path: '/v1/limits', headers });
    expect(get.status).toBe(200);

    const post = await rawRequest({ port, host: '::1', method: 'POST', path: '/v1/refresh', headers });
    expect(post.status).toBe(401);

    const authed = await rawRequest({
      port,
      host: '::1',
      method: 'POST',
      path: '/v1/refresh',
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
    });
    expect(authed.status).toBe(200);
  });

  it('accepts a single host string, as the daemon used to call it', async () => {
    const server = make();
    const port = await server.listen(0, '127.0.0.1');
    expect(server.addresses).toEqual([{ address: '127.0.0.1', port }]);
  });

  it('binds and unbinds an address after startup', async () => {
    if (!HAS_IPV6) return;
    const server = make();
    const port = await server.listen(0, '127.0.0.1');
    await server.bind('::1');
    expect(server.addresses.map((a) => a.address)).toContain('::1');
    expect((await rawRequest({ port, host: '::1', path: '/health', headers: { host: `[::1]:${port}` } })).status).toBe(200);

    await server.unbind('::1');
    expect(server.addresses.map((a) => a.address)).not.toContain('::1');
    expect(server.servers).toHaveLength(1);
    await expect(rawRequest({ port, host: '::1', path: '/health', headers: { host: `[::1]:${port}` } })).rejects.toThrow();
  });

  it('binding an address twice is a no-op that keeps the port', async () => {
    const server = make();
    const port = await server.listen(0, '127.0.0.1');
    await expect(server.bind('127.0.0.1')).resolves.toBe(port);
    expect(server.servers).toHaveLength(1);
  });

  it('rejects when the port is already taken', async () => {
    const first = make();
    const port = await first.listen(0, '127.0.0.1');
    const second = make();
    await expect(second.listen(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // The failed listener is not left behind.
    expect(second.servers).toHaveLength(0);
  });
});

describe('Host allowlist across bound addresses and MagicDNS', () => {
  it('accepts the MagicDNS name with and without a port, and 421s anything else', async () => {
    const server = make([MAGIC_DNS]);
    const port = await server.listen(0, '127.0.0.1');

    for (const host of [MAGIC_DNS, `${MAGIC_DNS}:${port}`, MAGIC_DNS.toUpperCase(), `127.0.0.1:${port}`, 'localhost']) {
      const res = await rawRequest({ port, path: '/health', headers: { host } });
      expect(res.status, host).toBe(200);
    }

    for (const host of [`${MAGIC_DNS}:1`, 'evil.example.com', `evil.example.com:${port}`]) {
      const res = await rawJson({ port, path: '/health', headers: { host } });
      expect(res.status, host).toBe(421);
      expect((res.json['error'] as { code: string }).code).toBe('misdirected_request');
    }
  });

  it('accepts a Host naming an address bound after startup', async () => {
    if (!HAS_IPV6) return;
    const server = make();
    const port = await server.listen(0, '127.0.0.1');
    // `::1` is always allowed as a name; a freshly bound address proves the policy is rebuilt.
    await server.bind('::1');
    expect(server.addresses.map((a) => `${a.address}:${a.port}`)).toContain(`::1:${port}`);
  });

  it('picks up MagicDNS names handed over after startup (SIGHUP)', async () => {
    const server = make();
    const port = await server.listen(0, '127.0.0.1');
    expect((await rawRequest({ port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(421);

    server.setExtraHostNames([MAGIC_DNS]);
    expect((await rawRequest({ port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(200);

    server.setExtraHostNames([]);
    expect((await rawRequest({ port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(421);
  });
});

describe('non-loopback authentication (§16)', () => {
  const policy = buildHostPolicy([{ address: '100.68.121.23', port: 47291 }], [MAGIC_DNS]);

  function fakeReq(over: { remote?: string; method?: string; host?: string; authorization?: string }): IncomingMessage {
    const headers: Record<string, string> = { host: over.host ?? '100.68.121.23:47291' };
    if (over.authorization !== undefined) headers['authorization'] = over.authorization;
    return {
      method: over.method ?? 'GET',
      headers,
      socket: { remoteAddress: over.remote ?? '100.68.121.90' },
    } as unknown as IncomingMessage;
  }

  it('401s a tokenless GET from the tailnet and points at pairing', () => {
    const gate = checkRequest(fakeReq({}), policy, TOKEN);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(401);
    expect(gate.code).toBe('unauthorized');
    expect(gate.message).toBe('a valid Authorization: Bearer token is required');
    expect(gate.hint).toContain('claude-usage configure pairing');
  });

  it('keeps the loopback hint for a tokenless mutating request', () => {
    const gate = checkRequest(fakeReq({ remote: '127.0.0.1', method: 'POST', host: 'localhost:47291' }), policy, TOKEN);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(401);
    expect(gate.hint).toContain('loopback');
  });

  it('accepts the token from the tailnet, on the MagicDNS Host', () => {
    const gate = checkRequest(fakeReq({ host: MAGIC_DNS, authorization: `Bearer ${TOKEN}` }), policy, TOKEN);
    expect(gate).toEqual({ ok: true, loopback: false });
  });
});
