// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * System programs by absolute path (§23.62).
 *
 * The daemon is long-lived and runs these unattended — `security` every ten minutes,
 * `launchctl`/`systemctl` on every self-update. Looked up through `PATH` they would run
 * whatever an earlier, writable `PATH` directory held. These are the places the OS puts
 * them; nothing else is consulted.
 */
import { existsSync } from 'node:fs';

/** macOS ships these at fixed paths. */
export const SECURITY_BIN = '/usr/bin/security';
export const LAUNCHCTL_BIN = '/bin/launchctl';

/** Where a Linux or macOS system keeps its own programs, in search order. */
export const SYSTEM_BIN_DIRS: readonly string[] = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** The `PATH` a helper script is given: the system directories and nothing else. */
export const SYSTEM_PATH = SYSTEM_BIN_DIRS.join(':');

/**
 * The first `<dir>/<name>` that exists among `SYSTEM_BIN_DIRS`. When none does — an
 * unusual distribution — the bare name is returned and the spawn fails cleanly rather than
 * running something unexpected (there is then nothing on the system directories to find).
 */
export function systemBin(name: string, exists: (path: string) => boolean = existsSync): string {
  for (const dir of SYSTEM_BIN_DIRS) {
    const path = `${dir}/${name}`;
    try {
      if (exists(path)) return path;
    } catch {
      // unreadable — try the next
    }
  }
  return name;
}

/** `PATH` with every relative or empty entry removed (an empty entry means "the cwd"). */
export function absolutePath(path: string | undefined): string {
  const kept = (path ?? '').split(':').filter((entry) => entry.startsWith('/'));
  return kept.length > 0 ? [...new Set(kept)].join(':') : SYSTEM_PATH;
}
