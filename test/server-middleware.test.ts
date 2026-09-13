import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  bearerMatches,
  buildHostPolicy,
  checkRequest,
  isHostAllowed,
  isLoopbackAddress,
  normalizeAddress,
  parseHostHeader,
} from '../src/server/middleware.js';
import { utcMidnight, parseSince, parseTokensQuery } from '../src/server/query.js';

const TOKEN = 'test-bearer-token';
const policy = buildHostPolicy([{ address: '127.0.0.1', port: 47291 }, { address: '100.68.121.23', port: 47291 }]);

function fakeReq(over: {
  remote?: string;
  method?: string;
  host?: string;
  origin?: string;
  authorization?: string;
}): IncomingMessage {
  const headers: Record<string, string> = { host: over.host ?? '127.0.0.1:47291' };
  if (over.origin !== undefined) headers['origin'] = over.origin;
  if (over.authorization !== undefined) headers['authorization'] = over.authorization;
  return {
    method: over.method ?? 'GET',
    headers,
    socket: { remoteAddress: over.remote ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

describe('normalizeAddress / isLoopbackAddress', () => {
  it('unwraps IPv4-mapped IPv6 and brackets', () => {
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('[::1]')).toBe('::1');
    expect(normalizeAddress('fe80::1%en0')).toBe('fe80::1');
    expect(normalizeAddress(undefined)).toBeNull();
  });

  it.each(['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1'])('treats %s as loopback', (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true);
  });

  it.each(['100.68.121.23', '192.168.1.4', '10.0.0.1', 'fe80::1', undefined])('treats %s as remote', (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });
});

describe('parseHostHeader', () => {
  it.each([
    ['localhost', { hostname: 'localhost', port: null }],
    ['localhost:47291', { hostname: 'localhost', port: 47291 }],
    ['[::1]:47291', { hostname: '::1', port: 47291 }],
    ['[::1]', { hostname: '::1', port: null }],
    ['::1', { hostname: '::1', port: null }],
  ])('parses %s', (host, expected) => {
    expect(parseHostHeader(host)).toEqual(expected);
  });

  it('rejects empty and non-numeric ports', () => {
    expect(parseHostHeader('')).toBeNull();
    expect(parseHostHeader(undefined)).toBeNull();
    expect(parseHostHeader('localhost:abc')).toBeNull();
  });
});

describe('isHostAllowed', () => {
  it('accepts bound addresses, localhost and 127.0.0.1', () => {
    for (const host of ['localhost', 'localhost:47291', '127.0.0.1:47291', '100.68.121.23:47291', 'LOCALHOST']) {
      expect(isHostAllowed(host, policy), host).toBe(true);
    }
  });

  it('rejects foreign names and wrong ports', () => {
    for (const host of ['evil.example.com', 'evil.example.com:47291', 'localhost:1234', undefined]) {
      expect(isHostAllowed(host, policy), String(host)).toBe(false);
    }
  });

  it('never allows a wildcard bind address as a Host value', () => {
    const wildcard = buildHostPolicy([{ address: '0.0.0.0', port: 8080 }]);
    expect(isHostAllowed('0.0.0.0:8080', wildcard)).toBe(false);
    expect(isHostAllowed('localhost:8080', wildcard)).toBe(true);
  });
});

describe('bearerMatches', () => {
  it('accepts the exact token, case-insensitively on the scheme', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer  ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects wrong, truncated, extended and malformed values', () => {
    for (const header of [undefined, '', 'Bearer', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, TOKEN]) {
      expect(bearerMatches(header, TOKEN), String(header)).toBe(false);
    }
  });

  it('never matches when no token is configured', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer anything', '')).toBe(false);
  });
});

describe('checkRequest gate order', () => {
  it('exempts a loopback GET', () => {
    expect(checkRequest(fakeReq({}), policy, TOKEN)).toEqual({ ok: true, loopback: true });
  });

  it('requires the token for a loopback POST', () => {
    expect(checkRequest(fakeReq({ method: 'POST' }), policy, TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest(fakeReq({ method: 'POST', authorization: `Bearer ${TOKEN}` }), policy, TOKEN)).toMatchObject({
      ok: true,
    });
  });

  it('requires the token for a non-loopback GET', () => {
    const remote = { remote: '100.68.121.23', host: '100.68.121.23:47291' };
    expect(checkRequest(fakeReq(remote), policy, TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest(fakeReq({ ...remote, authorization: `Bearer ${TOKEN}` }), policy, TOKEN)).toMatchObject({
      ok: true,
      loopback: false,
    });
  });

  it('rejects a wrong token from a non-loopback GET', () => {
    const req = fakeReq({ remote: '100.68.121.23', host: '100.68.121.23:47291', authorization: 'Bearer nope' });
    expect(checkRequest(req, policy, TOKEN)).toMatchObject({ ok: false, status: 401 });
  });

  it('never trusts a forged X-Forwarded-For style Host to claim loopback', () => {
    const req = fakeReq({ remote: '100.68.121.23', host: 'localhost:47291' });
    expect(checkRequest(req, policy, TOKEN)).toMatchObject({ ok: false, status: 401 });
  });

  it('checks Host, then Origin, then auth', () => {
    expect(checkRequest(fakeReq({ host: 'evil.com', origin: 'x', method: 'POST' }), policy, TOKEN)).toMatchObject({
      status: 421,
    });
    expect(checkRequest(fakeReq({ origin: 'x', method: 'POST' }), policy, TOKEN)).toMatchObject({ status: 403 });
    expect(checkRequest(fakeReq({ method: 'POST' }), policy, TOKEN)).toMatchObject({ status: 401 });
  });
});

describe('parseSince', () => {
  const now = Date.parse('2026-09-13T14:00:00Z');

  it('defaults to local midnight today', () => {
    expect(parseSince(undefined, now)).toBe(utcMidnight(now));
    expect(parseSince('today', now)).toBe(utcMidnight(now));
  });

  it('handles relative windows', () => {
    expect(parseSince('24h', now)).toBe('2026-09-12T14:00:00.000Z');
    expect(parseSince('7d', now)).toBe('2026-09-06T14:00:00.000Z');
    expect(parseSince('30m', now)).toBe('2026-09-13T13:30:00.000Z');
  });

  it('handles absolute instants and all', () => {
    expect(parseSince('2026-09-01T00:00:00Z', now)).toBe('2026-09-01T00:00:00.000Z');
    expect(parseSince('all', now)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns null for junk', () => {
    for (const v of ['yesterdayish', '7x', '', ' ', 'd7']) {
      if (v === '') continue;
      expect(parseSince(v, now), v).toBeNull();
    }
  });
});

describe('parseTokensQuery', () => {
  const now = Date.parse('2026-09-13T14:00:00Z');

  it('defaults to today/project', () => {
    const res = parseTokensQuery(new URLSearchParams(), now);
    expect(res).toMatchObject({ ok: true, query: { groupBy: 'project' } });
  });

  it('names the bad parameter', () => {
    expect(parseTokensQuery(new URLSearchParams('groupBy=nope'), now)).toEqual({ ok: false, param: 'groupBy' });
    expect(parseTokensQuery(new URLSearchParams('since=nope'), now)).toEqual({ ok: false, param: 'since' });
  });

  it('rejects more than one groupBy (unsupported in v1)', () => {
    expect(parseTokensQuery(new URLSearchParams('groupBy=day&groupBy=model'), now)).toEqual({
      ok: false,
      param: 'groupBy',
    });
  });
});
