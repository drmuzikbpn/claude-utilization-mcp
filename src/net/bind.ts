/**
 * `config.bind` → the concrete addresses the daemon listens on (§16).
 *
 * Each entry is an IP literal or one of the keywords `tailscale` and `lan` (§23.44). A keyword
 * that cannot be resolved is a warning and a skipped address, never an error — the daemon must still come
 * up on loopback. Anything else is a config error naming the offending key, because a typo
 * in `bind` would otherwise silently reduce the daemon's reachability.
 */
import { isIP } from 'node:net';
import { ConfigError } from '../config.js';
import { resolveLanIPv4 } from './lan.js';
import { resolveTailscaleIPv4 } from './tailscale.js';

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
}

/**
 * Resolve every `bind` entry, de-duped and in order.
 *
 * @throws ConfigError — `key` is `bind[i]` — for an entry that is neither an IP literal
 * nor a keyword.
 */
export async function resolveBindAddresses(bind: readonly string[], opts: BindOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
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
        const address = await resolver();
        resolved.set(keyword, address);
        if (address === null) log(warnings[keyword] ?? `bind: could not resolve "${keyword}"`);
      }
      const address = resolved.get(keyword);
      if (address !== null && address !== undefined) add(address);
      continue;
    }
    if (isIP(entry) === 0) {
      throw new ConfigError(`config key "bind[${index}]" must be an IP address or one of the keywords "tailscale", "lan"`, `bind[${index}]`);
    }
    add(entry.toLowerCase());
  }

  return out.length === 0 ? [DEFAULT_BIND_ADDRESS] : out;
}
