/**
 * Tailnet discovery (§16).
 *
 * Two questions, both answered best-effort and never fatal:
 * - which IPv4 address is this machine's tailnet address (`100.64.0.0/10`)?
 * - what is its MagicDNS name, so the `Host` allowlist can accept it?
 *
 * The interface table is the cheap path; the `tailscale` CLI is the fallback and may be
 * missing entirely. Anything unexpected — no binary, a timeout, garbage output — resolves
 * to `null`. Nothing here ever throws, because the daemon must still start without Tailscale.
 */
import { execFile } from 'node:child_process';
import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** How long the `tailscale` CLI is given before it is killed (§16). */
export const TAILSCALE_TIMEOUT_MS = 2_000;
export const TAILSCALE_BIN = 'tailscale';

export type InterfaceTable = NodeJS.Dict<NetworkInterfaceInfo[]>;
export type InterfacesFn = () => InterfaceTable;

/** Run a command and resolve with its stdout; rejects on non-zero exit, timeout or ENOENT. */
export type ExecFn = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<string>;

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, [...args], { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve(stdout);
    });
  });

/** True for an address inside the tailnet CGNAT range `100.64.0.0/10`. */
export function isTailscaleIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const parts = address.split('.');
  const second = Number(parts[1]);
  return parts[0] === '100' && second >= 64 && second <= 127;
}

/** First `100.64.0.0/10` address in an `os.networkInterfaces()` table, else `null`. */
export function findTailscaleIPv4(table: InterfaceTable): string | null {
  for (const entries of Object.values(table)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      // Node has reported `family` as both 'IPv4' and 4 across versions.
      const family: unknown = entry.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (typeof entry.address === 'string' && isTailscaleIPv4(entry.address)) return entry.address;
    }
  }
  return null;
}

export interface TailscaleOptions {
  /** Injectable `os.networkInterfaces` (tests, and re-resolution on SIGHUP). */
  interfaces?: InterfacesFn;
  exec?: ExecFn;
  timeoutMs?: number;
}

async function run(exec: ExecFn, args: readonly string[], timeoutMs: number): Promise<string | null> {
  try {
    return await exec(TAILSCALE_BIN, args, { timeoutMs });
  } catch {
    // No tailscale binary, a timeout, or a non-zero exit — all mean "no tailnet answer".
    return null;
  }
}

/**
 * This machine's tailnet IPv4 address, or `null`.
 *
 * Interfaces first; `tailscale ip -4` only when no interface is in range (§16).
 */
export async function resolveTailscaleIPv4(opts: TailscaleOptions = {}): Promise<string | null> {
  const interfaces = opts.interfaces ?? networkInterfaces;
  try {
    const found = findTailscaleIPv4(interfaces());
    if (found !== null) return found;
  } catch {
    // A platform that cannot enumerate interfaces still gets the CLI fallback.
  }

  const exec = opts.exec ?? defaultExec;
  const out = await run(exec, ['ip', '-4'], opts.timeoutMs ?? TAILSCALE_TIMEOUT_MS);
  if (out === null) return null;
  const first = out.split('\n')[0]?.trim() ?? '';
  return isIPv4(first) ? first : null;
}

/** `Self.DNSName` from `tailscale status --json`, trailing dot stripped, else `null`. */
export async function resolveMagicDnsName(opts: { exec?: ExecFn; timeoutMs?: number } = {}): Promise<string | null> {
  const exec = opts.exec ?? defaultExec;
  const out = await run(exec, ['status', '--json'], opts.timeoutMs ?? TAILSCALE_TIMEOUT_MS);
  if (out === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const self = (parsed as { Self?: unknown }).Self;
  if (typeof self !== 'object' || self === null) return null;
  const raw = (self as { DNSName?: unknown }).DNSName;
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\.$/, '');
  return name.length === 0 ? null : name;
}
