import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { saveConfig, defaultConfig } from '../../src/config.js';
import { serve, startDaemon, PortInUseError, type DaemonHandle, type DaemonOptions, type NetworkResolver } from '../../src/daemon.js';
import { FakeTokensSource } from '../helpers/fakes.js';
import { tempConfigDir } from '../helpers/fake-daemon.js';
import { rawRequest } from '../helpers/raw-request.js';

const MAGIC_DNS = 'alans-mbp.tail1234.ts.net';
const handles: DaemonHandle[] = [];
const sockets: NetServer[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.stop();
  }
  while (sockets.length > 0) {
    const s = sockets.pop();
    if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A resolver whose answers can change between SIGHUPs. */
class FakeNetwork implements NetworkResolver {
  ip: string | null = null;
  dns: string | null = null;
  calls = { ip: 0, dns: 0 };
  async tailscaleIPv4(): Promise<string | null> {
    this.calls.ip += 1;
    return this.ip;
  }
  async magicDnsName(): Promise<string | null> {
    this.calls.dns += 1;
    return this.dns;
  }
}

/** An address that is guaranteed not to exist on this machine. */
const UNROUTABLE = '203.0.113.7';

async function start(bind: string[], network: NetworkResolver, over: DaemonOptions = {}): Promise<DaemonHandle> {
  const configDir = tempConfigDir();
  const h = await startDaemon({
    configDir,
    config: { ...defaultConfig(), bind, auth: { token: 'test-bearer-token' } },
    port: 0,
    poll: false,
    sessions: false,
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    network,
    log: () => undefined,
    ...over,
  });
  handles.push(h);
  return h;
}

describe('startDaemon binding (§16)', () => {
  it('binds loopback only and never asks Tailscale anything', async () => {
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1'], net);
    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(net.calls).toEqual({ ip: 0, dns: 0 });
    expect(h.magicDnsName).toBeNull();
  });

  it('resolves the tailscale keyword and allows its MagicDNS Host', async () => {
    const net = new FakeNetwork();
    net.ip = '127.0.0.1'; // stands in for the tailnet address: bindable in a test
    net.dns = MAGIC_DNS;
    const h = await start(['tailscale'], net);

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(h.magicDnsName).toBe(MAGIC_DNS);
    const res = await rawRequest({ port: h.port, path: '/health', headers: { host: `${MAGIC_DNS}:${h.port}` } });
    expect(res.status).toBe(200);
  });

  it('warns and keeps serving when a non-loopback address cannot be bound', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    net.ip = UNROUTABLE;
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(lines.join('\n')).toMatch(/could not bind 203\.0\.113\.7/);
    expect((await rawRequest({ port: h.port, path: '/health' })).status).toBe(200);
  });

  it('warns and falls back to loopback when there is no tailnet at all', async () => {
    const lines: string[] = [];
    const h = await start(['tailscale'], new FakeNetwork(), { log: (l) => lines.push(l) });
    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(lines.join('\n')).toMatch(/no Tailscale IPv4/);
  });

  it('stays fatal when the loopback port is taken', async () => {
    const taken = createNetServer();
    sockets.push(taken);
    const port = await new Promise<number>((resolve) => {
      taken.listen(0, '127.0.0.1', () => {
        const addr = taken.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });

    await expect(start(['127.0.0.1'], new FakeNetwork(), { port })).rejects.toBeInstanceOf(PortInUseError);
  });

  it('rejects an invalid bind entry with a ConfigError naming the key', async () => {
    await expect(start(['127.0.0.1', 'not-an-address'], new FakeNetwork())).rejects.toMatchObject({
      name: 'ConfigError',
      key: 'bind[1]',
    });
  });
});

describe('SIGHUP re-resolution (§16)', () => {
  it('binds a tailnet address that only appeared later, and its MagicDNS name', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });
    expect(h.addresses).toEqual(['127.0.0.1']);
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(421);

    // The tailnet comes up. `::1` stands in for the new address so the test can bind it.
    net.ip = '::1';
    net.dns = MAGIC_DNS;
    await h.reload();

    expect(h.magicDnsName).toBe(MAGIC_DNS);
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(200);
    if (h.addresses.includes('::1')) {
      expect(lines.join('\n')).toMatch(/now also listening on ::1/);
    }
  });

  it('drops an address that went away and forgets its MagicDNS name', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    net.ip = '::1';
    net.dns = MAGIC_DNS;
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });
    const hadIpv6 = h.addresses.includes('::1');

    net.ip = null;
    net.dns = null;
    await h.reload();

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(h.magicDnsName).toBeNull();
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(421);
    expect((await rawRequest({ port: h.port, path: '/health' })).status).toBe(200);
    if (hadIpv6) expect(lines.join('\n')).toMatch(/stopped listening on ::1/);
  });

  it('is a no-op when nothing changed, and never re-asks a loopback-only daemon', async () => {
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1'], net);
    await h.reload();
    await h.reload();
    expect(net.calls).toEqual({ ip: 0, dns: 0 });
    expect(h.addresses).toEqual(['127.0.0.1']);
  });

  it('keeps serving when a newly resolved address cannot be bound', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });
    net.ip = UNROUTABLE;
    await h.reload();

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(lines.join('\n')).toMatch(/could not bind 203\.0\.113\.7/);
    expect((await rawRequest({ port: h.port, path: '/health' })).status).toBe(200);
  });

  it('does nothing after stop()', async () => {
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1', 'tailscale'], net);
    await h.stop();
    net.ip = '::1';
    await h.reload();
    expect(h.addresses).toEqual(['127.0.0.1']);
  });
});

describe('serve() wiring', () => {
  it('re-resolves on SIGHUP and removes the handler on shutdown', async () => {
    const dir = tempConfigDir();
    saveConfig({ ...defaultConfig(), bind: ['127.0.0.1', 'tailscale'], auth: { token: 'test-bearer-token' } }, dir);
    const net = new FakeNetwork();
    const lines: string[] = [];
    const before = process.listenerCount('SIGHUP');

    const promise = serve({
      configDir: dir,
      port: 0,
      poll: false,
      sessions: false,
      tokens: null,
      network: net,
      log: (l) => lines.push(l),
    });

    for (let i = 0; i < 200 && process.listenerCount('SIGHUP') === before; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);

    net.dns = MAGIC_DNS;
    process.emit('SIGHUP', 'SIGHUP');
    for (let i = 0; i < 200 && net.calls.dns < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(net.calls.dns).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).toMatch(/SIGHUP received/);

    process.emit('SIGTERM', 'SIGTERM');
    expect(await promise).toBe(0);
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });
});
