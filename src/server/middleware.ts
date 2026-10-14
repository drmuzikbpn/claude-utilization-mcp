// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Normalize an IPv4-mapped IPv6 address to its IPv4 form. */
export function normalizeAddress(addr: string | undefined | null): string | null {
  if (typeof addr !== 'string' || addr.length === 0) return null;
  let out = addr;
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  const pct = out.indexOf('%');
  if (pct !== -1) out = out.slice(0, pct);
  if (out.toLowerCase().startsWith('::ffff:')) {
    const tail = out.slice(7);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  }
  return out;
}

/** Loopback is decided from the socket's remote address, never from headers (§16). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  const a = normalizeAddress(addr);
  if (a === null) return false;
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

export interface ParsedHost {
  hostname: string;
  port: number | null;
}

export function parseHostHeader(host: string | undefined): ParsedHost | null {
  if (typeof host !== 'string' || host.length === 0) return null;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return null;
    const hostname = host.slice(1, close);
    const rest = host.slice(close + 1);
    if (rest.length === 0) return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) ? { hostname, port } : null;
  }
  const colon = host.lastIndexOf(':');
  if (colon === -1) return { hostname: host, port: null };
  // A bare IPv6 literal has several colons and no port.
  if (host.indexOf(':') !== colon) return { hostname: host, port: null };
  const port = Number(host.slice(colon + 1));
  if (!Number.isInteger(port)) return null;
  return { hostname: host.slice(0, colon), port };
}

export interface HostPolicy {
  /** Hostnames/IPs we are bound to, plus any configured extras. */
  names: ReadonlySet<string>;
  /** Ports we are actually listening on. */
  ports: ReadonlySet<number>;
}

export function buildHostPolicy(bound: ReadonlyArray<{ address: string; port: number }>, extraNames: readonly string[] = []): HostPolicy {
  const names = new Set<string>(['localhost', '127.0.0.1', '::1']);
  const ports = new Set<number>();
  for (const b of bound) {
    const addr = normalizeAddress(b.address);
    if (addr !== null) {
      names.add(addr.toLowerCase());
      // 0.0.0.0 / :: mean "every local address"; they are never a usable Host value.
      if (addr === '0.0.0.0' || addr === '::') names.delete(addr);
    }
    ports.add(b.port);
  }
  for (const n of extraNames) {
    if (typeof n === 'string' && n.length > 0) names.add(n.toLowerCase());
  }
  return { names, ports };
}

/** `Host` must name a bound address, `localhost` or `127.0.0.1`, else 421 (§16). */
export function isHostAllowed(host: string | undefined, policy: HostPolicy): boolean {
  const parsed = parseHostHeader(host);
  if (parsed === null) return false;
  if (!policy.names.has(parsed.hostname.toLowerCase())) return false;
  if (parsed.port === null) return true;
  return policy.ports.has(parsed.port);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time bearer comparison (§16). An unset configured token never matches. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (expected.length === 0) return false;
  if (typeof header !== 'string') return false;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (m === null) return false;
  const presented = m[1];
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Path of `req` with any query string and trailing slash removed. */
export function requestPath(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * `POST /v1/pair` (§23.47) — one of the two exceptions to "every request needs the bearer". It trades a single-use, five-minute, 128-bit code for the bearer, and the
 * route itself refuses anything but TLS and rate-limits failures per source. Host and Origin
 * checks still apply.
 */
export const PAIR_REDEEM_PATH = '/v1/pair';

export function isPairRedeem(method: string, path: string): boolean {
  return method === 'POST' && path === PAIR_REDEEM_PATH;
}

/** Did this request arrive on an HTTPS listener (§23.45)? */
export function isTlsRequest(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

/**
 * `GET /health` (§23.55) — the second and last exception. Without a token it answers
 * liveness only (`{ ok: true }`): no name, no version, no install state. With a valid token
 * it answers in full. A token that is present but wrong is still a `401`, so a paired app
 * keeps learning that its token was rotated.
 */
export const HEALTH_PATH = '/health';

export function isHealthProbe(method: string, path: string): boolean {
  return (method === 'GET' || method === 'HEAD') && path === HEALTH_PATH;
}

/**
 * Fetch-metadata values that mean "a person or a non-browser client asked for this"
 * (§23.55). Browsers attach `Sec-Fetch-Site` to every request a page makes, and scripts
 * cannot remove or forge it; `none` is a user typing the address. Anything else —
 * `same-origin`, `same-site`, `cross-site` — is a web page talking to us, which is never
 * legitimate: the daemon serves no pages.
 */
export function isFetchSiteAllowed(value: string | string[] | undefined): boolean {
  if (value === undefined) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'none';
}

export type GateOutcome =
  | {
      ok: true;
      loopback: boolean;
      /** `false` only for the two bearer-less exceptions; such a request gets nothing private. */
      authenticated: boolean;
    }
  | {
      ok: false;
      status: 401 | 403 | 421;
      code: 'unauthorized' | 'forbidden' | 'misdirected_request';
      message: string;
      hint?: string | undefined;
    };

/**
 * The request gate, in order (§16, §23.2, §23.55):
 * Host allowlist (421) → any Origin header, or a browser-initiated `Sec-Fetch-Site` (403) →
 * bearer (401).
 *
 * **Every request needs the bearer, from loopback too.** Loopback is not an identity: any
 * local process, and any web page the user has open, can connect to `127.0.0.1`. The only
 * requests answered without it are `POST /v1/pair` and a liveness-only `GET /health`.
 */
export function checkRequest(req: IncomingMessage, policy: HostPolicy, token: string): GateOutcome {
  const loopback = isLoopbackRequest(req);

  if (!isHostAllowed(req.headers.host, policy)) {
    return {
      ok: false,
      status: 421,
      code: 'misdirected_request',
      message: 'Host header is not an address this daemon is bound to',
    };
  }

  // Browsers attach Origin to cross-site requests; we serve no browser callers at all.
  if (req.headers.origin !== undefined) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'requests carrying an Origin header are refused',
      hint: 'claude-usage is not a browser-facing API',
    };
  }
  if (!isFetchSiteAllowed(req.headers['sec-fetch-site'])) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'requests initiated by a web page are refused',
      hint: 'claude-usage is not a browser-facing API',
    };
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const path = requestPath(req);

  // §23.47: the pairing code is the credential here; the route enforces TLS and the limits.
  if (isPairRedeem(method, path)) return { ok: true, loopback, authenticated: false };

  if (bearerMatches(req.headers.authorization, token)) return { ok: true, loopback, authenticated: true };

  // Liveness only, and only when no token was offered at all (see `HEALTH_PATH`).
  if (req.headers.authorization === undefined && isHealthProbe(method, path)) {
    return { ok: true, loopback, authenticated: false };
  }

  return {
    ok: false,
    status: 401,
    code: 'unauthorized',
    message: 'a valid Authorization: Bearer token is required',
    hint: loopback
      ? 'every request needs the token, from this machine too — it is in config.json (0600), and `claude-usage` reads it for you'
      : 'this device is not paired, or its token was changed — on that machine run `claude-usage pair` and pair again',
  };
}
