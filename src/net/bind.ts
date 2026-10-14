// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * `config.bind` → the concrete addresses the daemon listens on (§16).
 *
 * Each entry is an IP literal or one of the keywords `tailscale` and `lan` (§23.44). A keyword
 * that cannot be resolved is a warning and a skipped address, never an error — the daemon must still come
 * up on loopback. Anything else is a config error naming the offending key, because a typo
 * in `bind` would otherwise silently reduce the daemon's reachability.
 */
import { isIP, isIPv4 } from 'node:net';
import { ConfigError } from '../config.js';
import { resolveLanIPv4 } from './lan.js';
import { resolveTailscaleIPv4 } from './tailscale.js';

/**
 * Where an address reaches (§23.57). Only `wildcard` and `public` are refused by default:
 * a daemon that hands out usage data and can pause sessions has no business listening on
 * every interface, or on one the internet can route to, unless someone asked for exactly
 * that by name.
 */
export type AddressScope = 'loopback' | 'private' | 'cgnat' | 'link-local' | 'wildcard' | 'public';

function ipv4Scope(address: string): AddressScope {
  const [a, b] = address.split('.').map(Number) as [number, number];
  if (address === '0.0.0.0') return 'wildcard';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'link-local';
  return 'public';
}

/** Expand an IPv6 literal to its eight 16-bit groups, or `null` when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;
  // An embedded dotted quad occupies the last two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const left = head.length === 0 ? [] : head.split(':');
  const right = rest === undefined || rest.length === 0 ? [] : rest.split(':');
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: fill }, () => '0'), ...right].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Classify an IP literal. Anything that is not an IP literal is `public` — refused. */
export function addressScope(address: string): AddressScope {
  if (isIPv4(address)) return ipv4Scope(address);
  const g = ipv6Groups(address);
  if (g === null) return 'public';
  const first = g[0] as number;
  if (g.every((x) => x === 0)) return 'wildcard';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  // ::ffff:a.b.c.d — an IPv4 address in IPv6 clothing is judged as the IPv4 address it is.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return ipv4Scope(`${String((g[6] as number) >> 8)}.${String((g[6] as number) & 0xff)}.${String((g[7] as number) >> 8)}.${String((g[7] as number) & 0xff)}`);
  }
  if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7, unique local
  if ((first & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  return 'public';
}

/** May the daemon listen here without `allowPublicBind` (§23.57)? */
export function isBindAllowed(address: string, allowPublicBind: boolean): boolean {
  const scope = addressScope(address);
  return allowPublicBind || (scope !== 'wildcard' && scope !== 'public');
}

/** The tailnet keyword (§16). */
export const TAILSCALE_KEYWORD = 'tailscale';
/** The LAN keyword: the primary private IPv4 address (§23.44). */
export const LAN_KEYWORD = 'lan';
/** Every non-literal `bind` entry. */
export const BIND_KEYWORDS: readonly string[] = [TAILSCALE_KEYWORD, LAN_KEYWORD];

/** Does `bind` ask for `keyword` (case- and whitespace-insensitive)? */
export function bindWants(bind: readonly string[], keyword: string): boolean {
  return bind.some((entry) => entry.trim().toLowerCase() === keyword);
}
/** Used when `bind` is empty, or when nothing in it could be resolved. */
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

export interface BindOptions {
  /** Injectable tailnet lookup; defaults to the real `os`/CLI resolution. */
  resolveTailscale?: () => Promise<string | null>;
  /** Injectable LAN lookup; defaults to the interface table (§23.44). */
  resolveLan?: () => Promise<string | null>;
  log?: (line: string) => void;
  /** `config.allowPublicBind` (§23.57); `false` when omitted. */
  allowPublicBind?: boolean;
}

/**
 * Resolve every `bind` entry, de-duped and in order.
 *
 * @throws ConfigError — `key` is `bind[i]` — for an entry that is neither an IP literal
 * nor a keyword, and for a wildcard or publicly routable literal unless
 * `allowPublicBind` is set (§23.57). A *keyword* that resolves to such an address is
 * skipped with a warning instead, like any other keyword that cannot be used.
 */
export async function resolveBindAddresses(bind: readonly string[], opts: BindOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const allowPublicBind = opts.allowPublicBind === true;
  const resolveTailscale = opts.resolveTailscale ?? (() => resolveTailscaleIPv4());
  const resolveLan = opts.resolveLan ?? (() => Promise.resolve(resolveLanIPv4()));

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (address: string): void => {
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(address);
  };

  // Each keyword is resolved once even when it is listed several times.
  const resolved = new Map<string, string | null>();
  const resolvers: Record<string, () => Promise<string | null>> = {
    [TAILSCALE_KEYWORD]: resolveTailscale,
    [LAN_KEYWORD]: resolveLan,
  };
  const warnings: Record<string, string> = {
    [TAILSCALE_KEYWORD]: 'bind: no Tailscale IPv4 address found — skipping the "tailscale" entry',
    [LAN_KEYWORD]: 'bind: no private LAN IPv4 address found — skipping the "lan" entry',
  };
  for (const [index, raw] of bind.entries()) {
    const entry = raw.trim();
    const keyword = entry.toLowerCase();
    const resolver = resolvers[keyword];
    if (resolver !== undefined) {
      if (!resolved.has(keyword)) {
        let address = await resolver();
        if (address !== null && (isIP(address) === 0 || !isBindAllowed(address, allowPublicBind))) {
          log(`bind: the "${keyword}" keyword resolved to ${address}, which is not a private address — skipping it`);
          address = null;
        } else if (address === null) {
          log(warnings[keyword] ?? `bind: could not resolve "${keyword}"`);
        }
        resolved.set(keyword, address);
      }
      const address = resolved.get(keyword);
      if (address !== null && address !== undefined) add(address);
      continue;
    }
    if (isIP(entry) === 0) {
      throw new ConfigError(`config key "bind[${index}]" must be an IP address or one of the keywords "tailscale", "lan"`, `bind[${index}]`);
    }
    if (!isBindAllowed(entry, allowPublicBind)) {
      const what = addressScope(entry) === 'wildcard' ? 'every interface on this machine' : 'a publicly routable address';
      throw new ConfigError(
        `config key "bind[${index}]" is ${entry} — ${what}. claude-usage only listens on loopback, private and Tailscale addresses; ` +
          'use the "lan" or "tailscale" keyword, or set "allowPublicBind": true in config.json if you really mean it',
        `bind[${index}]`,
      );
    }
    add(entry.toLowerCase());
  }

  return out.length === 0 ? [DEFAULT_BIND_ADDRESS] : out;
}
