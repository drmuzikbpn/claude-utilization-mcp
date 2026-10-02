import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateTlsIdentity } from '../../src/net/tls.js';
import { createServer, type UsageServer } from '../../src/server/index.js';
import { FakeLimitsProvider, FakeTokensSource, testConfig } from '../helpers/fakes.js';
import { rawRequest } from '../helpers/raw-request.js';

const started: UsageServer[] = [];
afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

const identity = loadOrCreateTlsIdentity({ configDir: mkdtempSync(join(tmpdir(), 'cu-tls-srv-')), name: 'test' });

function make(withTls = true): UsageServer {
  const server = createServer({
    config: testConfig(),
    limits: new FakeLimitsProvider(),
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    ...(withTls ? { tls: { key: identity.key, cert: identity.cert } } : {}),
  });
  started.push(server);
  return server;
}

describe('HTTPS listeners (§23.45)', () => {
  it('serves the same handler over TLS on its own port, next to plain HTTP', async () => {
    const server = make();
    const port = await server.listen(0, '127.0.0.1');
    const tlsPort = await server.bind('127.0.0.1', 0, { tls: true });
    expect(tlsPort).not.toBe(port);
    expect(server.tlsPort).toBe(tlsPort);

    const https = await rawRequest({ port: tlsPort, tls: true, path: '/health', headers: { host: `127.0.0.1:${tlsPort}` } });
    expect(https.status).toBe(200);
    expect(JSON.parse(https.body)['version']).toBe('9.9.9');
    expect((await rawRequest({ port, path: '/health' })).status).toBe(200);
  });

  it('lists listeners with their tls flag, and the Host policy admits the TLS port', async () => {
    const server = make();
    const port = await server.listen(0, '127.0.0.1');
    const tlsPort = await server.bind('127.0.0.1', 0, { tls: true });
    expect(server.listeners).toEqual([
      { addr: '127.0.0.1', port, tls: false },
      { addr: '127.0.0.1', port: tlsPort, tls: true },
    ]);
    expect(server.addresses).toContainEqual({ address: '127.0.0.1', port: tlsPort, tls: true });
  });

  it('a TLS bind without a TLS identity is refused', async () => {
    const server = make(false);
    await server.listen(0, '127.0.0.1');
    await expect(server.bind('127.0.0.1', 0, { tls: true })).rejects.toThrow(/TLS/);
  });

  it('unbind drops both the HTTP and the HTTPS listener of a host', async () => {
    const server = make();
    await server.listen(0, '127.0.0.1');
    const tlsPort = await server.bind('127.0.0.1', 0, { tls: true });
    await server.unbind('127.0.0.1');
    expect(server.listeners).toEqual([]);
    expect(server.tlsPort).toBeNull();
    await expect(rawRequest({ port: tlsPort, tls: true, path: '/health' })).rejects.toThrow();
  });
});

describe('after close() (review fix)', () => {
  it('bind() refuses once the server is closed', async () => {
    const server = make();
    await server.listen(0, '127.0.0.1');
    await server.close();
    await expect(server.bind('127.0.0.1', 0)).rejects.toThrow(/closed/);
    await expect(server.bind('127.0.0.1', 0, { tls: true })).rejects.toThrow(/closed/);
    expect(server.listeners).toEqual([]);
  });
});
