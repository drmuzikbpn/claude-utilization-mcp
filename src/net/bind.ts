/**
 * `config.bind` → the concrete addresses the daemon listens on (§16).
 *
 * Each entry is either an IP literal or the keyword `tailscale`. A tailnet that cannot be
 * resolved is a warning and a skipped address, never an error — the daemon must still come
 * up on loopback. Anything else is a config error naming the offending key, because a typo
 * in `bind` would otherwise silently reduce the daemon's reachability.
 */
import { isIP } from 'node:net';
import { ConfigError } from '../config.js';
import { resolveTailscaleIPv4 } from './tailscale.js';

/** The one non-literal `bind` entry (§16). */
export const TAILSCALE_KEYWORD = 'tailscale';
/** Used when `bind` is empty, or when nothing in it could be resolved. */
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

export interface BindOptions {
  /** Injectable tailnet lookup; defaults to the real `os`/CLI resolution. */
  resolveTailscale?: () => Promise<string | null>;
  log?: (line: string) => void;
}

/**
 * Resolve every `bind` entry, de-duped and in order.
 *
 * @throws ConfigError — `key` is `bind[i]` — for an entry that is neither an IP literal
 * nor `tailscale`.
 */
export async function resolveBindAddresses(bind: readonly string[], opts: BindOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const resolveTailscale = opts.resolveTailscale ?? (() => resolveTailscaleIPv4());

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (address: string): void => {
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(address);
  };

  let tailnet: string | null | undefined;
  for (const [index, raw] of bind.entries()) {
    const entry = raw.trim();
    if (entry.toLowerCase() === TAILSCALE_KEYWORD) {
      // Resolve once even when the keyword is listed several times.
      if (tailnet === undefined) {
        tailnet = await resolveTailscale();
        if (tailnet === null) {
          log('bind: no Tailscale IPv4 address found — skipping the "tailscale" entry');
        }
      }
      if (tailnet !== null) add(tailnet);
      continue;
    }
    if (isIP(entry) === 0) {
      throw new ConfigError(`config key "bind[${index}]" must be an IP address or the keyword "tailscale"`, `bind[${index}]`);
    }
    add(entry.toLowerCase());
  }

  return out.length === 0 ? [DEFAULT_BIND_ADDRESS] : out;
}
