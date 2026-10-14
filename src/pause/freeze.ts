// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
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
import { frozenProcsOf, type FrozenProc } from './freeze-records.js';

export { frozenProcsOf, type FrozenProc } from './freeze-records.js';
import { PAUSE_FILE_VERSION, pauseFilePath, type PauseRule } from './rules.js';

/**
 * `ps` and `sysctl` by absolute path: the daemon is long-lived and signals processes on
 * the strength of what these print, so they are not looked up through a `PATH` that a
 * login shell, a service file or an attacker-writable directory could have reordered.
 */
export const PS_BIN = '/bin/ps';
export const SYSCTL_BIN = '/usr/sbin/sysctl';
/** `PID_MAX` on macOS and the BSDs. */
export const BSD_PID_MAX = 99_999;

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
    text = execFileSync(PS_BIN, ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 });
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

/**
 * What makes a pid *this* process and not whatever later reused the number (§23.56).
 *
 * `start` is an opaque token that only has to compare equal for the same process and
 * differ for any other: the kernel's start time in clock ticks on Linux (`/proc/<pid>/stat`
 * field 22), `ps -o lstart=` elsewhere. Pids are recycled; a (pid, start) pair is not.
 */
export interface ProcIdentity {
  pid: number;
  uid: number;
  start: string;
  /** The full command line as the OS reports it; `argv[0]` first. */
  command: string;
}

/** `lstart` is five whitespace-separated fields: `Tue Oct 13 22:09:10 2026`. */
const PS_IDENTITY_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function parsePsIdentities(text: string): Map<number, ProcIdentity> {
  const out = new Map<number, ProcIdentity>();
  for (const line of text.split('\n')) {
    const m = PS_IDENTITY_LINE.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    out.set(pid, { pid, uid: Number(m[2]), start: (m[3] as string).replace(/\s+/g, ' '), command: (m[4] as string).trim() });
  }
  return out;
}

function inspectViaProc(pid: number): ProcIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces and parentheses; fields after the last ')' are stable. The
    // slice starts at field 3 (state), so starttime — field 22 — is index 19.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[19];
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const uid = /^Uid:\s+(\d+)/m.exec(status);
    if (start === undefined || !/^\d+$/.test(start) || uid === null) return null;
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a.length > 0).join(' ');
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    return { pid, uid: Number(uid[1]), start, command: cmdline.length > 0 ? cmdline : comm };
  } catch {
    return null;
  }
}

/**
 * Identity of each pid that still exists; a pid that is gone is simply absent. One `ps`
 * for the whole batch where there is no `/proc`.
 */
export function inspectProcesses(pids: readonly number[]): Map<number, ProcIdentity> {
  const wanted = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  const out = new Map<number, ProcIdentity>();
  if (wanted.length === 0) return out;
  if (process.platform === 'linux') {
    for (const pid of wanted) {
      const id = inspectViaProc(pid);
      if (id !== null) out.set(pid, id);
    }
    return out;
  }
  // BSD `ps` refuses the whole list if one pid is above its PID_MAX; such a pid cannot exist.
  const askable = wanted.filter((p) => p <= BSD_PID_MAX);
  if (askable.length === 0) return out;
  let text: string;
  try {
    text = execFileSync(PS_BIN, ['-o', 'pid=,uid=,lstart=,command=', '-p', askable.join(',')], {
      encoding: 'utf8',
      timeout: 5_000,
      // `lstart` is locale-formatted; pin it so the token is stable across restarts.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // `ps -p` exits 1 when some pid is gone but still prints the ones it found.
    const stdout = (err as { stdout?: unknown }).stdout;
    text = typeof stdout === 'string' ? stdout : '';
  }
  return parsePsIdentities(text);
}

/**
 * Something that changes on every boot and never within one (§23.56): the kernel's
 * `boot_id` on Linux, `kern.boottime` on macOS. Pids and start times recorded under a
 * different boot id describe processes that no longer exist, whatever now holds the number.
 */
export function readBootId(): string | null {
  if (process.platform === 'linux') {
    try {
      const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (id.length > 0) return id;
    } catch {
      // fall through to "unknown"
    }
    return null;
  }
  try {
    const out = execFileSync(SYSCTL_BIN, ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(out);
    return m === null ? null : `${m[1] as string}.${m[2] as string}`;
  } catch {
    return null;
  }
}

/**
 * Is this command line a Claude Code session (§23.56)? The daemon only ever accepts such a
 * pid as a session, so a token holder cannot point a freeze at an arbitrary process.
 *
 * The rule, checked against the first word of the command line (`argv[0]`) and the rest:
 *
 * 1. `argv[0]`'s basename is exactly `claude` — the native launcher, and the process title
 *    Claude Code sets, which is what `ps` and `/proc/<pid>/cmdline` both report;
 * 2. `argv[0]` is a file inside the native installer's `…/claude/versions/` directory;
 * 3. the command line runs the npm package's entry point, `…/@anthropic-ai/claude-code/…cli.js`.
 *
 * Nothing else matches: not `claude-usage`, not a shell that merely has `claude` among its
 * arguments, not an editor with a file called `claude` open.
 */
export function isClaudeCodeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const argv0 = trimmed.split(/\s+/)[0] as string;
  const base = argv0.slice(argv0.lastIndexOf('/') + 1);
  if (base === 'claude') return true;
  if (/\/claude\/versions\/[^/\s]+$/.test(argv0)) return true;
  return /(^|\s)\S*\/@anthropic-ai\/claude-code\/\S*cli\.[cm]?js(\s|$)/.test(trimmed);
}

export interface FreezeDeps {
  listProcesses(): ProcEntry[];
  /** Identity of each pid that still exists (§23.56). */
  inspect(pids: readonly number[]): Map<number, ProcIdentity>;
  selfUid(): number;
  /** The daemon's own pid: it and its ancestors are never signalled. */
  selfPid(): number;
  bootId(): string | null;
  /** May this process be registered as a session? `isClaudeCodeCommand` outside tests. */
  isSessionProcess(identity: ProcIdentity): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export function defaultFreezeDeps(): FreezeDeps {
  return {
    listProcesses,
    inspect: inspectProcesses,
    selfUid: () => (typeof process.getuid === 'function' ? process.getuid() : 0),
    selfPid: () => process.pid,
    bootId: readBootId,
    isSessionProcess: (identity) => isClaudeCodeCommand(identity.command),
    kill: (pid, signal) => process.kill(pid, signal),
  };
}

/** SIGSTOP/SIGCONT ignoring `ESRCH` — the process may have exited already (§18.3). */
export function signalIgnoringEsrch(deps: FreezeDeps, pid: number, signal: NodeJS.Signals): boolean {
  try {
    deps.kill(pid, signal);
    return true;
  } catch {
    // ESRCH: already gone. EPERM: not ours. Either way there is nothing more to do.
    return false;
  }
}

/** `pid`'s parent chain, nearest first, as far as the table knows it. */
export function ancestorsOf(pid: number, table: readonly ProcEntry[]): number[] {
  const parent = new Map<number, number>();
  for (const e of table) parent.set(e.pid, e.ppid);
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  let current = parent.get(pid);
  while (current !== undefined && current > 0 && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = parent.get(current);
  }
  return out;
}

/**
 * Pids no signal of ours may ever reach (§23.56): the daemon and everything above it. A
 * session can be an ancestor of the daemon — `claude-usage serve` started from a Claude
 * Code terminal — and freezing that session's tree must not stop the daemon that would
 * later have to thaw it. Pid 0 and 1 are never ours to signal either.
 */
export function protectedPids(deps: Pick<FreezeDeps, 'selfPid'>, table: readonly ProcEntry[]): Set<number> {
  const self = deps.selfPid();
  return new Set<number>([0, 1, self, ...ancestorsOf(self, table)]);
}

export interface FreezeOptions {
  /** The start time recorded when this pid was registered; a mismatch means the pid was reused. */
  expectStart?: string | null;
  /**
   * Called with the processes about to be stopped, **before** the first `SIGSTOP` (§23.56).
   * The caller persists them here, so a crash between two signals can never leave a stopped
   * process that `resume --all` does not know about.
   */
  record?: (frozen: FrozenProc[]) => void;
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
 * §23.56: the root must still be the process that was registered (`expectStart`), every
 * child must be ours, nothing in `protectedPids` is ever signalled, and the list is handed
 * to `record` before any signal is sent.
 *
 * Returns the recorded `frozenPids` nearest-first — the order `thaw()` wants, so a parent
 * shell is resumed before the children it owns.
 */
export function freezeTree(pid: number | null, deps: FreezeDeps = defaultFreezeDeps(), opts: FreezeOptions = {}): number[] {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) {
    throw new FreezeRefused('no_pid', 'this session has no trusted pid to freeze');
  }
  const self = deps.selfUid();
  const root = deps.inspect([pid]).get(pid);
  if (root === undefined) {
    throw new FreezeRefused('gone', `process ${pid} is gone`);
  }
  if (root.uid !== self) {
    throw new FreezeRefused('foreign_uid', `process ${pid} is not owned by this user`);
  }
  if (opts.expectStart !== undefined && opts.expectStart !== null && opts.expectStart !== root.start) {
    throw new FreezeRefused('gone', `process ${pid} is no longer the session that registered it`);
  }
  const table = deps.listProcesses();
  const off = protectedPids(deps, table);
  const candidates = descendantsOf(pid, table).filter((child) => !off.has(child));
  const identities = deps.inspect(candidates);
  const frozen: FrozenProc[] = [];
  for (const child of candidates) {
    const id = identities.get(child);
    if (id !== undefined && id.uid === self) frozen.push({ pid: child, start: id.start });
  }
  // On disk first, signals second.
  opts.record?.(frozen.map((f) => ({ ...f })));
  // Deepest first, so no child can be reparented onto a still-running shell mid-freeze.
  // The BFS list is nearest-first, so walk it backwards.
  for (let i = frozen.length - 1; i >= 0; i -= 1) {
    signalIgnoringEsrch(deps, (frozen[i] as FrozenProc).pid, 'SIGSTOP');
  }
  return frozen.map((f) => f.pid);
}

/**
 * SIGCONT in recorded order — nearest-first, so a shell resumes before its children (§18.3).
 *
 * §23.56: a pid is only signalled while it is still the process that was stopped — same
 * start time, same user. A recycled pid, a foreign one, and anything in `protectedPids` is
 * skipped. A bare number is a record from before start times were kept: it gets the
 * ownership check only, because leaving a process stopped for ever is the worse failure and
 * `SIGCONT` to a running process of the same user does nothing.
 */
export function thaw(entries: readonly (number | FrozenProc)[], deps: FreezeDeps = defaultFreezeDeps()): number[] {
  const wanted: FrozenProc[] = [];
  for (const entry of entries) {
    const proc: FrozenProc | null =
      typeof entry === 'number' ? { pid: entry, start: null } : entry !== null && typeof entry === 'object' ? entry : null;
    if (proc === null || !Number.isInteger(proc.pid) || proc.pid <= 1) continue;
    wanted.push(proc);
  }
  if (wanted.length === 0) return [];
  const self = deps.selfUid();
  const identities = deps.inspect(wanted.map((w) => w.pid));
  const off = protectedPids(deps, deps.listProcesses());
  const resumed: number[] = [];
  for (const proc of wanted) {
    const id = identities.get(proc.pid);
    if (id === undefined || id.uid !== self || off.has(proc.pid)) continue;
    if (typeof proc.start === 'string' && proc.start !== id.start) continue;
    if (signalIgnoringEsrch(deps, proc.pid, 'SIGCONT')) resumed.push(proc.pid);
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
 * Reads `sessions.json` and `pause.json` straight off disk, SIGCONTs every recorded pid
 * that is still the process that was stopped (§23.56) and clears the rules.
 */
export function resumeAll(configDir: string, deps: FreezeDeps = defaultFreezeDeps()): ResumeAllResult {
  let sessions: StoredSession[] = [];
  let rest: Record<string, unknown> = {};
  let rev = 0;
  let recordedBoot: unknown;
  try {
    const parsed = JSON.parse(readFileSync(sessionsFilePath(configDir), 'utf8')) as Record<string, unknown>;
    rest = parsed;
    if (Array.isArray(parsed['sessions'])) sessions = parsed['sessions'] as StoredSession[];
    if (typeof parsed['rev'] === 'number') rev = parsed['rev'];
    recordedBoot = parsed['bootId'];
  } catch {
    sessions = [];
  }

  // §23.56: pids recorded before the last reboot name nothing we stopped. Forget them
  // without signalling whatever holds those numbers now.
  const boot = deps.bootId();
  const rebooted = typeof recordedBoot === 'string' && boot !== null && recordedBoot !== boot;

  const resumed: number[] = [];
  for (const session of sessions) {
    if (session === null || typeof session !== 'object') continue;
    if (!rebooted) for (const pid of thaw(frozenProcsOf(session), deps)) resumed.push(pid);
    session.frozenPids = [];
    session.frozenStarts = [];
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
      writeJsonFile(sessionsFilePath(configDir), { ...rest, version: 1, rev: rev + 1, sessions });
    } catch {
      // best effort
    }
  }

  return { resumed, removed, sessions: sessions.length };
}

/**
 * The crash path (§23.56): SIGCONT everything `sessions.json` says is stopped and clear
 * those records, leaving the pause rules alone so a restarted daemon freezes again. Reads
 * the file rather than any in-memory state, so it works from an `uncaughtException` handler
 * whatever the daemon had got to. Never throws.
 */
export function thawRecorded(configDir: string, deps: FreezeDeps = defaultFreezeDeps()): number[] {
  const resumed: number[] = [];
  try {
    const parsed = JSON.parse(readFileSync(sessionsFilePath(configDir), 'utf8')) as Record<string, unknown>;
    const sessions = Array.isArray(parsed['sessions']) ? (parsed['sessions'] as StoredSession[]) : [];
    const boot = deps.bootId();
    const rebooted = typeof parsed['bootId'] === 'string' && boot !== null && parsed['bootId'] !== boot;
    let changed = false;
    for (const session of sessions) {
      if (session === null || typeof session !== 'object') continue;
      const procs = frozenProcsOf(session);
      if (procs.length === 0 && (session.frozenPid ?? null) === null) continue;
      if (!rebooted) for (const pid of thaw(procs, deps)) resumed.push(pid);
      session.frozenPids = [];
      session.frozenStarts = [];
      session.frozenPid = null;
      changed = true;
    }
    if (changed) writeJsonFile(sessionsFilePath(configDir), { ...parsed, sessions });
  } catch {
    // Nothing recorded, or nothing readable: there is nothing we know to resume.
  }
  return resumed;
}
