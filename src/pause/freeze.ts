/**
 * Hard freeze (§18.3) — SIGSTOP/SIGCONT over a process tree.
 *
 * Everything here is deliberately synchronous and dependency-free: a `ps` call costs a few
 * milliseconds and the safety invariants (SIGCONT on shutdown, offline `resume --all`) must
 * work from a signal handler and from a CLI with no daemon at all.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { writeJsonFile } from '../config.js';
import { sessionsFilePath } from '../sessions/registry.js';
import type { StoredSession } from '../sessions/types.js';
import { PAUSE_FILE_VERSION, pauseFilePath, type PauseRule } from './rules.js';

export interface ProcEntry {
  pid: number;
  ppid: number;
}

export type FreezeRefusal = 'foreign_uid' | 'no_pid' | 'gone';

/** Refusals are never thrown at a hook; the routes map them to 409/410. */
export class FreezeRefused extends Error {
  readonly reason: FreezeRefusal;
  constructor(reason: FreezeRefusal, message: string) {
    super(message);
    this.name = 'FreezeRefused';
    this.reason = reason;
  }
}

/** `/proc/<pid>/stat` on Linux, `ps -axo pid=,ppid=` elsewhere (§18.3). */
export function listProcesses(): ProcEntry[] {
  if (process.platform === 'linux') {
    const out: ProcEntry[] = [];
    let names: string[];
    try {
      names = readdirSync('/proc');
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        // comm may contain spaces and parentheses; fields after the last ')' are stable.
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        const ppid = Number(fields[1]);
        if (Number.isInteger(ppid)) out.push({ pid: Number(name), ppid });
      } catch {
        // the process exited between readdir and read — ignore
      }
    }
    if (out.length > 0) return out;
  }
  let text: string;
  try {
    text = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    return [];
  }
  return parseProcessTable(text);
}

export function parseProcessTable(text: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m === null) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return out;
}

/** Breadth-first descendants of `pid`, nearest first. Cycles cannot occur but are guarded. */
export function descendantsOf(pid: number, table: readonly ProcEntry[]): number[] {
  const byParent = new Map<number, number[]>();
  for (const e of table) {
    const list = byParent.get(e.ppid);
    if (list === undefined) byParent.set(e.ppid, [e.pid]);
    else list.push(e.pid);
  }
  const seen = new Set<number>([pid]);
  const out: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** The owning uid of `pid`, or `null` when it cannot be determined. */
export function uidOf(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /^Uid:\s+(\d+)/m.exec(status);
      if (m !== null) return Number(m[1]);
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'uid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    const value = Number(out.trim());
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export interface FreezeDeps {
  listProcesses(): ProcEntry[];
  uidOf(pid: number): number | null;
  selfUid(): number;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export function defaultFreezeDeps(): FreezeDeps {
  return {
    listProcesses,
    uidOf,
    selfUid: () => (typeof process.getuid === 'function' ? process.getuid() : 0),
    kill: (pid, signal) => process.kill(pid, signal),
  };
}

/** SIGSTOP/SIGCONT ignoring `ESRCH` — the process may have exited already (§18.3). */
export function signalIgnoringEsrch(deps: FreezeDeps, pid: number, signal: NodeJS.Signals): boolean {
  try {
    deps.kill(pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return false;
    return false;
  }
}

/**
 * Freeze the tool subprocesses **below** `pid`, deepest first — and deliberately **not**
 * `pid` itself (§23.16).
 *
 * `pid` is the interactive `claude` process. `SIGSTOP`ing it stops the session's own TUI,
 * which the shell reports as `suspended` and hands the prompt back; after `SIGCONT` it is a
 * background job that cannot read the terminal until the user types `fg`. A hard pause is
 * meant to stop Claude's *work*, not to take away the terminal — so the root is left
 * runnable and the session is held at the `PreToolUse` gate instead (§18.2). The freeze is
 * what stops the work already in flight; the gate is what stops the next piece of it.
 *
 * Consequence, and it is the intended one: freezing a session that has no tool running is a
 * no-op on the process table. Nothing is stopped because nothing is running, and the very
 * next tool call blocks at the gate.
 *
 * Returns the recorded `frozenPids` nearest-first — the order `thaw()` wants, so a parent
 * shell is resumed before the children it owns.
 */
export function freezeTree(pid: number | null, deps: FreezeDeps = defaultFreezeDeps()): number[] {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) {
    throw new FreezeRefused('no_pid', 'this session has no trusted pid to freeze');
  }
  const self = deps.selfUid();
  const owner = deps.uidOf(pid);
  if (owner === null) {
    throw new FreezeRefused('gone', `process ${pid} is gone`);
  }
  if (owner !== self) {
    throw new FreezeRefused('foreign_uid', `process ${pid} is not owned by this user`);
  }
  const table = deps.listProcesses();
  const children = descendantsOf(pid, table).filter((child) => deps.uidOf(child) === self);
  // Deepest first, so no child can be reparented onto a still-running shell mid-freeze.
  // The BFS list is nearest-first, so walk it backwards.
  for (let i = children.length - 1; i >= 0; i -= 1) {
    signalIgnoringEsrch(deps, children[i] as number, 'SIGSTOP');
  }
  return children;
}

/** SIGCONT in recorded order — nearest-first, so a shell resumes before its children (§18.3). Ignores `ESRCH`. */
export function thaw(pids: readonly number[], deps: FreezeDeps = defaultFreezeDeps()): number[] {
  const resumed: number[] = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (signalIgnoringEsrch(deps, pid, 'SIGCONT')) resumed.push(pid);
  }
  return resumed;
}

export interface ResumeAllResult {
  resumed: number[];
  removed: string[];
  sessions: number;
}

/**
 * §18.3's documented escape hatch: `claude-usage resume --all` with **no running daemon**.
 * Reads `sessions.json` and `pause.json` straight off disk, SIGCONTs every recorded pid and
 * clears the rules.
 */
export function resumeAll(configDir: string, deps: FreezeDeps = defaultFreezeDeps()): ResumeAllResult {
  let sessions: StoredSession[] = [];
  let rev = 0;
  try {
    const parsed = JSON.parse(readFileSync(sessionsFilePath(configDir), 'utf8')) as {
      rev?: number;
      sessions?: StoredSession[];
    };
    if (Array.isArray(parsed.sessions)) sessions = parsed.sessions;
    if (typeof parsed.rev === 'number') rev = parsed.rev;
  } catch {
    sessions = [];
  }

  const resumed: number[] = [];
  for (const session of sessions) {
    const pids = Array.isArray(session.frozenPids) ? session.frozenPids : [];
    for (const pid of thaw(pids, deps)) resumed.push(pid);
    session.frozenPids = [];
    session.frozenPid = null;
    session.freezes = 0;
    session.pausedSince = null;
  }

  let removed: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(pauseFilePath(configDir), 'utf8')) as { rules?: PauseRule[] };
    removed = (parsed.rules ?? []).map((r) => r.id).filter((id) => typeof id === 'string');
  } catch {
    removed = [];
  }

  try {
    writeJsonFile(pauseFilePath(configDir), { version: PAUSE_FILE_VERSION, rules: [] });
  } catch {
    // best effort
  }
  if (sessions.length > 0) {
    try {
      writeJsonFile(sessionsFilePath(configDir), { version: 1, rev: rev + 1, sessions });
    } catch {
      // best effort
    }
  }

  return { resumed, removed, sessions: sessions.length };
}
