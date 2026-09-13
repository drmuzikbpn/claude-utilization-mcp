import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Methods that need no bearer token when they come from loopback (§16). */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

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

/**
 * The three endpoints our own hooks POST to from loopback with **no token** (§17.1).
 *
 * Claude Code runs `claude-usage hook` as a bare command: it has no way to read the bearer
 * token without also handing every hook the credential, and a `SessionStart` that cannot
 * register makes the whole sessions view wrong. These three are write-only session
 * bookkeeping keyed by a session id the caller must already know, they expose no data back,
 * and the exemption is loopback-ONLY — from the tailnet they still require the token, like
 * every other mutating request. Pause/resume are deliberately NOT on this list.
 */
export const LOOPBACK_HOOK_POSTS: readonly RegExp[] = [
  /^\/v1\/sessions\/register$/,
  /^\/v1\/sessions\/[^/]+\/heartbeat$/,
  /^\/v1\/sessions\/[^/]+\/end$/,
];

/** Path of `req` with any query string and trailing slash removed. */
export function requestPath(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export function isLoopbackHookPost(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  return LOOPBACK_HOOK_POSTS.some((re) => re.test(path));
}

export type GateOutcome =
  | { ok: true; loopback: boolean }
  | {
      ok: false;
      status: 401 | 403 | 421;
      code: 'unauthorized' | 'forbidden' | 'misdirected_request';
      message: string;
      hint?: string | undefined;
    };

/**
 * The request gate, in order (§16, §23.2):
 * loopback detection → Host allowlist (421) → any Origin header (403) → auth (401).
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

  const method = (req.method ?? 'GET').toUpperCase();
  if (loopback && SAFE_METHODS.has(method)) return { ok: true, loopback };

  // Narrow exemption: the hook's own session bookkeeping, loopback only (see above).
  if (loopback && isLoopbackHookPost(method, requestPath(req))) return { ok: true, loopback };

  if (!bearerMatches(req.headers.authorization, token)) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: 'a valid Authorization: Bearer token is required',
      hint: loopback
        ? 'mutating requests need the token even from loopback'
        : 'pair this device with `claude-usage configure pairing`',
    };
  }
  return { ok: true, loopback };
}
