/**
 * LAN discovery (§23.44, §23.46).
 *
 * Two questions, both answered best-effort and never fatal:
 * - which private IPv4 address would a phone on the same Wi-Fi reach this machine on?
 * - what is this machine's `.local` name, so the `Host` allowlist can accept it?
 *
 * The address comes from the interface table only — no subprocess — because the daemon
 * re-reads it every 30 s to notice a network change (§23.44).
 */
import { isIPv4 } from 'node:net';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { defaultExec, type ExecFn, type InterfaceTable, type InterfacesFn } from './tailscale.js';

export type { InterfaceTable, InterfacesFn } from './tailscale.js';

/** VM/container bridges (Docker `br-`, libvirt, VirtualBox), VPN tunnels (utun, tun, tap, WireGuard), Apple's peer-to-peer links and loopback — never the phone's network. */
export const EXCLUDED_INTERFACE = /^(bridge|br-|virbr|vmnet|vboxnet|docker|utun|tun|tap|wg|awdl|llw|lo)/;
/** How long `scutil --get LocalHostName` is given (§23.46). */
export const SCUTIL_TIMEOUT_MS = 2_000;

/** `10/8`, `172.16/12` or `192.168/16` (RFC 1918). */
export function isPrivateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number) as [number, number];
  if (a === 10) return true;
  if (a === 172) return b >= 16 && b <= 31;
  return a === 192 && b === 168;
}

export function isExcludedInterface(name: string): boolean {
  return EXCLUDED_INTERFACE.test(name);
}

/** First non-internal RFC 1918 IPv4 on a non-excluded interface, in table order; else `null`. */
export function findLanIPv4(table: InterfaceTable): string | null {
  for (const [name, entries] of Object.entries(table)) {
    if (isExcludedInterface(name) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || entry.internal) continue;
      // Node has reported `family` as both 'IPv4' and 4 across versions.
      const family: unknown = entry.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (typeof entry.address === 'string' && isPrivateIPv4(entry.address)) return entry.address;
    }
  }
  return null;
}

/** This machine's LAN IPv4 address, or `null`. Never throws. */
export function resolveLanIPv4(opts: { interfaces?: InterfacesFn } = {}): string | null {
  try {
    return findLanIPv4((opts.interfaces ?? networkInterfaces)());
  } catch {
    return null;
  }
}

export interface LocalHostNameOptions {
  platform?: NodeJS.Platform | string;
  exec?: ExecFn;
  hostname?: () => string;
  timeoutMs?: number;
}

function asLocalName(raw: string): string | null {
  const label = raw.trim().split('.')[0]?.toLowerCase() ?? '';
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? `${label}.local` : null;
}

/**
 * `<LocalHostName>.local` — what macOS answers for over mDNS (`scutil --get LocalHostName`),
 * falling back to the first label of `os.hostname()`. Lower-cased; `null` when neither is a
 * usable DNS label. Never throws.
 */
export async function resolveLocalHostName(opts: LocalHostNameOptions = {}): Promise<string | null> {
  const platform = String(opts.platform ?? process.platform);
  if (platform === 'darwin') {
    try {
      const out = await (opts.exec ?? defaultExec)('scutil', ['--get', 'LocalHostName'], {
        timeoutMs: opts.timeoutMs ?? SCUTIL_TIMEOUT_MS,
      });
      const name = asLocalName(out);
      if (name !== null) return name;
    } catch {
      // No scutil, or no LocalHostName set — the hostname is the next best answer.
    }
  }
  try {
    return asLocalName((opts.hostname ?? osHostname)());
  } catch {
    return null;
  }
}
