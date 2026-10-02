import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateTlsIdentity } from '../../src/net/tls.js';
import { createServer, type UsageServer } from '../../src/server/index.js';
import {
  buildPairingLink,
  createPairingCodes,
  orderPairingAddrs,
  PAIR_CODE_TTL_MS,
  PAIR_FAILURE_WINDOW_MS,
} from '../../src/server/pairing.js';
import { FakeLimitsProvider, FakeTokensSource, testConfig } from '../helpers/fakes.js';
import { rawRequest } from '../helpers/raw-request.js';

const TOKEN = 'test-bearer-token';

describe('pairing codes (§23.47)', () => {
  it('mints a 128-bit base64url code that redeems exactly once', () => {
    let t = 1_000;
    const codes = createPairingCodes({ now: () => t });
    const { code, expiresAt } = codes.mint();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Date.parse(expiresAt)).toBe(t + PAIR_CODE_TTL_MS);
    expect(codes.redeem(code, '192.168.1.5')).toBe('ok');
    expect(codes.redeem(code, '192.168.1.5')).toBe('invalid');
    t += 1;
  });

  it('expires after five minutes', () => {
    let t = 0;
    const codes = createPairingCodes({ now: () => t });
    const { code } = codes.mint();
    t = PAIR_CODE_TTL_MS;
    expect(codes.redeem(code, 'a')).toBe('invalid');
  });

  it('minting a new code voids the previous one', () => {
    const codes = createPairingCodes();
    const first = codes.mint().code;
    const second = codes.mint().code;
    expect(codes.redeem(first, 'a')).toBe('invalid');
    expect(codes.redeem(second, 'a')).toBe('ok');
  });

  it('rejects non-strings and wrong codes without burning the real one', () => {
    const codes = createPairingCodes();
    const { code } = codes.mint();
    expect(codes.redeem(undefined, 'a')).toBe('invalid');
    expect(codes.redeem(42, 'a')).toBe('invalid');
    expect(codes.redeem(`${code}x`, 'a')).toBe('invalid');
    expect(codes.redeem(code, 'a')).toBe('ok');
  });

  it('rate-limits a source after five failures in a minute — even for the right code', () => {
    let t = 0;
    const codes = createPairingCodes({ now: () => t });
    const { code } = codes.mint();
    for (let i = 0; i < 5; i += 1) expect(codes.redeem('wrong', '10.0.0.9')).toBe('invalid');
    expect(codes.redeem(code, '10.0.0.9')).toBe('rate_limited');
    // Another source is unaffected.
    expect(codes.redeem('wrong', '10.0.0.10')).toBe('invalid');
    // The window passes.
    t += PAIR_FAILURE_WINDOW_MS;
    expect(codes.redeem(code, '10.0.0.9')).toBe('ok');
  });
});

describe('pairing code status (§23.52)', () => {
  it('reports none → pending → redeemed, and a fresh mint starts over', () => {
    let t = 0;
    const codes = createPairingCodes({ now: () => t });
    expect(codes.status()).toEqual({ state: 'none', expiresAt: null });
    const { code, expiresAt } = codes.mint();
    expect(codes.status()).toEqual({ state: 'pending', expiresAt });
    codes.redeem('wrong', 'a');
    expect(codes.status().state).toBe('pending');
    expect(codes.redeem(code, 'a')).toBe('ok');
    expect(codes.status()).toEqual({ state: 'redeemed', expiresAt });
    t = PAIR_CODE_TTL_MS * 2; // redeemed stays redeemed after the expiry passes
    expect(codes.status().state).toBe('redeemed');
    codes.mint();
    expect(codes.status().state).toBe('pending');
  });

  it('reports expired once an unused code times out', () => {
    let t = 0;
    const codes = createPairingCodes({ now: () => t });
    codes.mint();
    t = PAIR_CODE_TTL_MS;
    expect(codes.status().state).toBe('expired');
  });
});

describe('pairing link (§23.47)', () => {
  it('matches the contract shape and percent-encodes', () => {
    const link = buildPairingLink({
      name: 'Alan’s Studio',
      addrs: ['192.168.1.20', 'studio.local', '100.101.102.103'],
      port: 47_292,
      fp: 'ab'.repeat(32),
      code: 'abcDEF0123456789_-xyzQ',
    });
    expect(link).toBe(
      'usagedeck://pair?v=2&name=Alan%E2%80%99s%20Studio&addrs=192.168.1.20%2Cstudio.local%2C100.101.102.103' +
        `&port=47292&fp=${'ab'.repeat(32)}&code=abcDEF0123456789_-xyzQ`,
    );
    const parsed = new URL(link);
    expect(parsed.searchParams.get('addrs')?.split(',')).toEqual(['192.168.1.20', 'studio.local', '100.101.102.103']);
    expect(parsed.searchParams.get('name')).toBe('Alan’s Studio');
  });

  it('orders candidates LAN, .local, tailnet, other literals, loopback last', () => {
    expect(
      orderPairingAddrs(['127.0.0.1', '100.101.102.103', '10.9.9.9', '192.168.1.20'], {
        lan: '192.168.1.20',
        tailnet: '100.101.102.103',
        localHostName: 'studio.local',
      }),
    ).toEqual(['192.168.1.20', 'studio.local', '100.101.102.103', '10.9.9.9', '127.0.0.1']);
  });

  it('never offers a wildcard bind address (same rule as the Host policy)', () => {
    expect(orderPairingAddrs(['0.0.0.0', '::', '192.168.1.20'], { lan: null, tailnet: null, localHostName: null })).toEqual([
      '192.168.1.20',
    ]);
  });

  it('offers the .local name only when the LAN address has TLS', () => {
    expect(orderPairingAddrs(['100.101.102.103'], { lan: '192.168.1.20', tailnet: '100.101.102.103', localHostName: 'studio.local' })).toEqual([
      '100.101.102.103',
    ]);
  });
});

// --- over HTTP(S) ---------------------------------------------------------------

const identity = loadOrCreateTlsIdentity({ configDir: mkdtempSync(join(tmpdir(), 'cu-pair-')), name: 'test' });
const started: UsageServer[] = [];
afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

async function make(opts: { tls?: boolean } = {}): Promise<{ server: UsageServer; port: number; tlsPort: number }> {
  const server = createServer({
    config: testConfig(),
    limits: new FakeLimitsProvider(),
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    tls: { key: identity.key, cert: identity.cert },
    pairing: {
      info: () => ({
        addrs: server.listeners.filter((l) => l.tls).map((l) => l.addr),
        port: server.tlsPort,
        fp: identity.fingerprint,
      }),
    },
  });
  started.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const tlsPort = opts.tls === false ? 0 : await server.bind('127.0.0.1', 0, { tls: true });
  return { server, port, tlsPort };
}

const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;

async function mint(port: number): Promise<Record<string, unknown>> {
  const res = await rawRequest({ port, method: 'POST', path: '/v1/pair/code', headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return json(res.body);
}

function redeem(tlsPort: number, code: unknown): ReturnType<typeof rawRequest> {
  return rawRequest({
    port: tlsPort,
    tls: true,
    method: 'POST',
    path: '/v1/pair',
    headers: { host: `127.0.0.1:${tlsPort}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

/** Drive `handle()` directly so the peer address can be anything — a socket test cannot. */
function viaHandle(server: UsageServer, port: number, remoteAddress: string, path: string, method = 'POST'): Promise<{ status: number; body: string }> {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  req.push(null);
  const res = new ServerResponse(req);
  return new Promise((resolve) => {
    let status = 0;
    res.writeHead = ((code: number) => {
      status = code;
      return res;
    }) as typeof res.writeHead;
    res.end = ((body?: string) => {
      resolve({ status, body: body ?? '' });
      return res;
    }) as typeof res.end;
    server.handle(req, res);
  });
}

describe('POST /v1/pair/code (§23.47)', () => {
  it('is 403 off-loopback even with the bearer', async () => {
    const { server, port } = await make();
    const res = await viaHandle(server, port, '192.168.1.5', '/v1/pair/code');
    expect(res.status).toBe(403);
    expect(json(res.body)['error']).toMatchObject({ code: 'forbidden' });
    // The same request from loopback is fine, so it is the address that was refused.
    expect((await viaHandle(server, port, '127.0.0.1', '/v1/pair/code')).status).toBe(200);
  });

  it('needs the bearer even from loopback', async () => {
    const { port } = await make();
    expect((await rawRequest({ port, method: 'POST', path: '/v1/pair/code' })).status).toBe(401);
  });

  it('answers code, expiry, link and the link’s parts — and never the token', async () => {
    const { port, tlsPort } = await make();
    const body = await mint(port);
    expect(body).toMatchObject({ name: 'test-host', addrs: ['127.0.0.1'], port: tlsPort, fp: identity.fingerprint });
    expect(String(body['code'])).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(String(body['link'])).toBe(
      buildPairingLink({ name: 'test-host', addrs: ['127.0.0.1'], port: tlsPort, fp: identity.fingerprint, code: String(body['code']) }),
    );
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('is 409 with a fix when there is no HTTPS listener', async () => {
    const { port } = await make({ tls: false });
    const res = await rawRequest({ port, method: 'POST', path: '/v1/pair/code', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(409);
    expect(json(res.body)['error']).toMatchObject({ code: 'conflict' });
    expect(res.body).toContain('configure lan on');
  });
});

describe('GET /v1/pair/code (§23.52)', () => {
  it('tells loopback whether the latest code was used — never the code or the token', async () => {
    const { port, tlsPort } = await make();
    const status = async (): Promise<Record<string, unknown>> => json((await rawRequest({ port, method: 'GET', path: '/v1/pair/code' })).body);
    expect(await status()).toEqual({ state: 'none', expiresAt: null });
    const { code } = await mint(port);
    expect((await status())['state']).toBe('pending');
    expect((await redeem(tlsPort, code)).status).toBe(200);
    const after = await status();
    expect(after['state']).toBe('redeemed');
    expect(JSON.stringify(after)).not.toContain(String(code));
    expect(JSON.stringify(after)).not.toContain(TOKEN);
  });

  it('is 403 off-loopback', async () => {
    const { server, port } = await make();
    expect((await viaHandle(server, port, '192.168.1.5', '/v1/pair/code', 'GET')).status).toBe(403);
  });
});

describe('POST /v1/pair (§23.47)', () => {
  it('trades a valid code for the token over TLS, with no bearer, once', async () => {
    const { port, tlsPort } = await make();
    const { code } = await mint(port);
    const ok = await redeem(tlsPort, code);
    expect(ok.status).toBe(200);
    expect(json(ok.body)).toEqual({ token: TOKEN, name: 'test-host', fp: identity.fingerprint });

    const again = await redeem(tlsPort, code);
    expect(again.status).toBe(401);
    expect(json(again.body)['error']).toMatchObject({
      code: 'unauthorized',
      message: 'pairing code is invalid or expired',
      hint: 'run `claude-usage pair` again',
    });
  });

  it('refuses plain HTTP — even with the right code — and does not burn it', async () => {
    const { port, tlsPort } = await make();
    const { code } = await mint(port);
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(403);
    expect(json(res.body)['error']).toMatchObject({ code: 'forbidden', hint: 'pair over https' });
    expect((await redeem(tlsPort, code)).status).toBe(200);
  });

  it('answers 429 after five failures from one address', async () => {
    const { port, tlsPort } = await make();
    const { code } = await mint(port);
    for (let i = 0; i < 5; i += 1) expect((await redeem(tlsPort, 'nope')).status).toBe(401);
    const limited = await redeem(tlsPort, code);
    expect(limited.status).toBe(429);
    expect(json(limited.body)['error']).toMatchObject({ code: 'rate_limited' });
  });

  it('still enforces the Host allowlist and the Origin refusal', async () => {
    const { tlsPort } = await make();
    const badHost = await rawRequest({ port: tlsPort, tls: true, method: 'POST', path: '/v1/pair', headers: { host: 'evil.example' }, body: '{}' });
    expect(badHost.status).toBe(421);
    const origin = await rawRequest({
      port: tlsPort,
      tls: true,
      method: 'POST',
      path: '/v1/pair',
      headers: { host: `127.0.0.1:${tlsPort}`, origin: 'https://evil.example' },
      body: '{}',
    });
    expect(origin.status).toBe(403);
  });

  it('the bearer exemption covers /v1/pair only', async () => {
    const { tlsPort } = await make();
    const res = await rawRequest({ port: tlsPort, tls: true, method: 'POST', path: '/v1/refresh', headers: { host: `127.0.0.1:${tlsPort}` } });
    expect(res.status).toBe(401);
  });
});
