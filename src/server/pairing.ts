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
export const PAIR_LINK_SCHEME = 'usagedeck://pair';

export type RedeemOutcome = 'ok' | 'invalid' | 'rate_limited';

export interface PairingCodes {
  /** Mint a fresh code, voiding any unused one. */
  mint(): { code: string; expiresAt: string };
  /** Redeem `code` on behalf of `source` (the normalized remote address). */
  redeem(code: unknown, source: string): RedeemOutcome;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createPairingCodes(opts: { now?: () => number; random?: (n: number) => Buffer } = {}): PairingCodes {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? randomBytes;
  let current: { digest: Buffer; expiresAt: number } | null = null;
  const failures = new Map<string, number[]>();

  const recentFailures = (source: string, t: number): number[] => {
    // Sweep every source, so a scan from many addresses cannot grow the map without bound.
    for (const [key, times] of failures) {
      const kept = times.filter((at) => t - at < PAIR_FAILURE_WINDOW_MS);
      if (kept.length === 0) failures.delete(key);
      else failures.set(key, kept);
    }
    return failures.get(source) ?? [];
  };

  return {
    mint() {
      const code = random(16).toString('base64url');
      const expiresAt = now() + PAIR_CODE_TTL_MS;
      current = { digest: digest(code), expiresAt };
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    },
    redeem(code, source) {
      const t = now();
      const recent = recentFailures(source, t);
      if (recent.length >= PAIR_FAILURE_LIMIT) return 'rate_limited';
      const live = current !== null && t < current.expiresAt ? current : null;
      if (live !== null && typeof code === 'string' && timingSafeEqual(digest(code), live.digest)) {
        current = null; // burned
        return 'ok';
      }
      failures.set(source, [...recent, t]);
      return 'invalid';
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
  const out: string[] = [];
  if (known.lan !== null && tlsHosts.includes(known.lan)) {
    out.push(known.lan);
    if (known.localHostName !== null) out.push(known.localHostName);
  }
  if (known.tailnet !== null && tlsHosts.includes(known.tailnet) && !out.includes(known.tailnet)) out.push(known.tailnet);
  for (const h of tlsHosts) if (!out.includes(h) && !isLoopback(h)) out.push(h);
  for (const h of tlsHosts) if (!out.includes(h)) out.push(h);
  return out;
}
