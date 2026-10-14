// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * One-time pairing codes (§23.47).
 *
 * The v2 pairing link carries a short-lived, single-use code instead of the bearer, so a QR
 * code that leaks — a screenshot, a screen share — is worth nothing five minutes later or
 * once the phone has used it. `POST /v1/pair` trades the code for the bearer over TLS; it is
 * the one mutating endpoint that needs no bearer, which is why everything here is strict:
 * 128-bit codes, one live code at a time, constant-time comparison, and a per-source failure
 * limit. Codes live only in memory and are never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PAIR_CODE_TTL_MS = 300_000;
/** Failures allowed per source inside one window; the next attempt is refused with 429. */
export const PAIR_FAILURE_LIMIT = 5;
export const PAIR_FAILURE_WINDOW_MS = 60_000;
/**
 * §23.63: how many distinct sources the failure table holds. A scan from more addresses
 * than this (a /64 of IPv6 is plenty) gets `rate_limited` for every new source until old
 * entries age out, rather than an ever-growing table.
 */
export const PAIR_FAILURE_SOURCES_MAX = 1_024;
/** The table is swept at most this often, not on every request. */
export const PAIR_FAILURE_SWEEP_MS = 5_000;
export const PAIR_LINK_SCHEME = 'usagedeck://pair';

export type RedeemOutcome = 'ok' | 'invalid' | 'rate_limited';

/** What became of the most recently minted code (§23.52) — never the code itself. */
export type PairCodeState = 'none' | 'pending' | 'redeemed' | 'expired';

export interface PairingCodes {
  /** Mint a fresh code, voiding any unused one. */
  mint(): { code: string; expiresAt: string };
  /** Redeem `code` on behalf of `source` (the normalized remote address). */
  redeem(code: unknown, source: string): RedeemOutcome;
  /** The latest code's fate, so `claude-usage pair` can tell its page the phone is in. */
  status(): { state: PairCodeState; expiresAt: string | null };
  /** §23.63: void the live code at once — `claude-usage pair` stopped before a phone used it. */
  revoke(): boolean;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Compared against when no code is live; random, so no input can match it. */
const NO_CODE = randomBytes(32);

export function createPairingCodes(opts: { now?: () => number; random?: (n: number) => Buffer } = {}): PairingCodes {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? randomBytes;
  let current: { digest: Buffer; expiresAt: number } | null = null;
  /** The latest mint, kept after it is burned so its fate can be reported. */
  let latest: { expiresAt: number; redeemed: boolean } | null = null;
  const failures = new Map<string, number[]>();

  let sweptAt = Number.NEGATIVE_INFINITY;
  const recentFailures = (source: string, t: number): number[] => {
    // Sweep the whole table now and then, not per request: with the size cap below that
    // bounds both the memory and the work a scan can cause (§23.63).
    if (t - sweptAt >= PAIR_FAILURE_SWEEP_MS) {
      sweptAt = t;
      for (const [key, times] of failures) {
        const kept = times.filter((at) => t - at < PAIR_FAILURE_WINDOW_MS);
        if (kept.length === 0) failures.delete(key);
        else failures.set(key, kept);
      }
    }
    return (failures.get(source) ?? []).filter((at) => t - at < PAIR_FAILURE_WINDOW_MS);
  };

  return {
    mint() {
      const code = random(16).toString('base64url');
      const expiresAt = now() + PAIR_CODE_TTL_MS;
      current = { digest: digest(code), expiresAt };
      latest = { expiresAt, redeemed: false };
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    },
    redeem(code, source) {
      const t = now();
      const recent = recentFailures(source, t);
      if (recent.length >= PAIR_FAILURE_LIMIT) return 'rate_limited';
      // A full table admits no new source at all — not even one holding the right code.
      if (!failures.has(source) && failures.size >= PAIR_FAILURE_SOURCES_MAX) return 'rate_limited';
      // Always compare, against a throwaway digest when there is nothing to match, so the
      // time taken says nothing about whether a code is live or what was sent.
      const live = current !== null && t < current.expiresAt;
      const expected = current?.digest ?? NO_CODE;
      const matches = timingSafeEqual(digest(typeof code === 'string' ? code : ''), expected);
      if (matches && live && typeof code === 'string') {
        current = null; // burned
        if (latest !== null) latest.redeemed = true;
        return 'ok';
      }
      failures.set(source, [...recent, t]);
      return 'invalid';
    },
    revoke() {
      const had = current !== null && now() < current.expiresAt;
      current = null;
      if (latest !== null && !latest.redeemed) latest.expiresAt = Math.min(latest.expiresAt, now());
      return had;
    },
    status() {
      if (latest === null) return { state: 'none', expiresAt: null };
      const expiresAt = new Date(latest.expiresAt).toISOString();
      if (latest.redeemed) return { state: 'redeemed', expiresAt };
      return { state: now() < latest.expiresAt ? 'pending' : 'expired', expiresAt };
    },
  };
}

export interface PairingLinkParts {
  name: string;
  addrs: readonly string[];
  port: number;
  fp: string;
  code: string;
}

/** `usagedeck://pair?v=2&name=…&addrs=…&port=…&fp=…&code=…` — the contract's exact order. */
export function buildPairingLink(p: PairingLinkParts): string {
  const enc = encodeURIComponent;
  return `${PAIR_LINK_SCHEME}?v=2&name=${enc(p.name)}&addrs=${enc(p.addrs.join(','))}&port=${String(p.port)}&fp=${enc(p.fp)}&code=${enc(p.code)}`;
}

/**
 * The link's address candidates, best first: the LAN address, the `.local` name (which only
 * resolves on the LAN, so only when the LAN address has TLS), the tailnet address, any other
 * literal, loopback last. `tlsHosts` are the hosts with an HTTPS listener.
 */
export function orderPairingAddrs(
  tlsHosts: readonly string[],
  known: { lan: string | null; tailnet: string | null; localHostName: string | null },
): string[] {
  const isLoopback = (h: string): boolean => h === '::1' || h.startsWith('127.');
  // 0.0.0.0 / :: mean "every local address" and are never dialable — as in buildHostPolicy.
  const hosts = tlsHosts.filter((h) => h !== '0.0.0.0' && h !== '::');
  const out: string[] = [];
  if (known.lan !== null && hosts.includes(known.lan)) {
    out.push(known.lan);
    if (known.localHostName !== null) out.push(known.localHostName);
  }
  if (known.tailnet !== null && hosts.includes(known.tailnet) && !out.includes(known.tailnet)) out.push(known.tailnet);
  for (const h of hosts) if (!out.includes(h) && !isLoopback(h)) out.push(h);
  for (const h of hosts) if (!out.includes(h)) out.push(h);
  return out;
}
