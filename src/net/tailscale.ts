// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Tailnet discovery (§16, §23.57).
 *
 * Two questions, both answered best-effort and never fatal:
 * - which IPv4 address is this machine's tailnet address (`100.64.0.0/10`)?
 * - what is its MagicDNS name, so the `Host` allowlist can accept it?
 *
 * `100.64.0.0/10` is carrier-grade NAT space, not Tailscale's own: an ISP or another VPN
 * can put such an address on any interface. So being in range is necessary and not
 * sufficient — the address must also be on an interface Tailscale names after itself
 * (`tailscale0`, Linux), or be the one the `tailscale` CLI reports. Anything unexpected —
 * no binary, a timeout, garbage output, an out-of-range answer — resolves to `null`.
 * Nothing here ever throws, because the daemon must still start without Tailscale.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** How long the `tailscale` CLI is given before it is killed (§16). */
export const TAILSCALE_TIMEOUT_MS = 2_000;
export const TAILSCALE_BIN = 'tailscale';
/**
 * Where the `tailscale` CLI is installed, most specific first (§23.57). The daemon binds a
 * listener on the strength of what this program prints, so it is found at a known absolute
 * path rather than through whatever `PATH` the service or the shell happened to have.
 */
export const TAILSCALE_PATHS: readonly string[] = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale',
  '/usr/sbin/tailscale',
  '/snap/bin/tailscale',
  '/run/current-system/sw/bin/tailscale',
];
/** Interface names Tailscale creates under its own name (Linux, the BSDs). */
export const TAILSCALE_INTERFACE = /^tailscale\d*$/;

/** The first installed CLI, or `null`: there is no falling back to a bare `PATH` lookup. */
export function findTailscaleBin(exists: (path: string) => boolean = existsSync): string | null {
  for (const path of TAILSCALE_PATHS) {
    try {
      if (exists(path)) return path;
    } catch {
      // unreadable directory — try the next one
    }
  }
  return null;
}

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

/**
 * First `100.64.0.0/10` address in an `os.networkInterfaces()` table, else `null`. With
 * `onlyTailscaleInterfaces`, only interfaces Tailscale names after itself are considered.
 */
export function findTailscaleIPv4(table: InterfaceTable, onlyTailscaleInterfaces = false): string | null {
  for (const [name, entries] of Object.entries(table)) {
    if (!Array.isArray(entries)) continue;
    if (onlyTailscaleInterfaces && !TAILSCALE_INTERFACE.test(name)) continue;
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
  /** The CLI to run; `null` means none is installed. Defaults to `findTailscaleBin()`. */
  bin?: string | null;
}

/**
 * Which CLI to run. An injected `exec` (tests) decides for itself what a name means, so it
 * is handed the bare name; the real one only ever gets an absolute path, or nothing.
 */
function cliFor(opts: { exec?: ExecFn; bin?: string | null }): string | null {
  if (opts.bin !== undefined) return opts.bin;
  return opts.exec === undefined ? findTailscaleBin() : TAILSCALE_BIN;
}

async function run(exec: ExecFn, bin: string | null, args: readonly string[], timeoutMs: number): Promise<string | null> {
  if (bin === null) return null;
  try {
    return await exec(bin, args, { timeoutMs });
  } catch {
    // A timeout or a non-zero exit — both mean "no tailnet answer".
    return null;
  }
}

/**
 * This machine's tailnet IPv4 address, or `null` (§23.57).
 *
 * 1. an in-range address on an interface named `tailscale*` — Tailscale's own, no question;
 * 2. otherwise what `tailscale ip -4` prints, **if** that is inside `100.64.0.0/10`. On
 *    macOS the interface is an anonymous `utun`, so the CLI is the only confirmation there
 *    is. The CLI also answers while Tailscale is switched off (§23.21) — the bind then
 *    fails and is retried, which is the intended behaviour.
 *
 * An in-range address on some other interface that the CLI does not vouch for is **not**
 * the tailnet, and is never returned.
 */
export async function resolveTailscaleIPv4(opts: TailscaleOptions = {}): Promise<string | null> {
  const interfaces = opts.interfaces ?? networkInterfaces;
  try {
    const found = findTailscaleIPv4(interfaces(), true);
    if (found !== null) return found;
  } catch {
    // A platform that cannot enumerate interfaces still gets the CLI.
  }

  const exec = opts.exec ?? defaultExec;
  const bin = cliFor(opts);
  const out = await run(exec, bin, ['ip', '-4'], opts.timeoutMs ?? TAILSCALE_TIMEOUT_MS);
  if (out === null) return null;
  const first = out.split('\n')[0]?.trim() ?? '';
  return isTailscaleIPv4(first) ? first : null;
}

/** `Self.DNSName` from `tailscale status --json`, trailing dot stripped, else `null`. */
export async function resolveMagicDnsName(opts: { exec?: ExecFn; timeoutMs?: number; bin?: string | null } = {}): Promise<string | null> {
  const exec = opts.exec ?? defaultExec;
  const bin = cliFor(opts);
  const out = await run(exec, bin, ['status', '--json'], opts.timeoutMs ?? TAILSCALE_TIMEOUT_MS);
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
  const name = raw.trim().replace(/\.$/, '').toLowerCase();
  // It becomes an accepted `Host` value, so it must look like a DNS name and nothing else.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) && name.length <= 253 ? name : null;
}
