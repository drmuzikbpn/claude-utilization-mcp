// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * The on-disk shape of a recorded freeze (§23.56). Its own module, with no imports, so the
 * session registry and the freezer can both use it without importing each other.
 */

/** A stopped process as recorded on disk: the pid, and the start time that proves it. */
export interface FrozenProc {
  pid: number;
  /** `null` only for a record written before §23.56, which carried bare pids. */
  start: string | null;
}

/** The (pid, start) pairs a stored session recorded, tolerating a pre-§23.56 file. */
export function frozenProcsOf(session: { frozenPids?: unknown; frozenStarts?: unknown }): FrozenProc[] {
  const pids = Array.isArray(session.frozenPids) ? session.frozenPids : [];
  const starts = Array.isArray(session.frozenStarts) ? session.frozenStarts : [];
  const out: FrozenProc[] = [];
  pids.forEach((pid, i) => {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
    const start: unknown = starts[i];
    out.push({ pid, start: typeof start === 'string' && start.length > 0 ? start : null });
  });
  return out;
}

