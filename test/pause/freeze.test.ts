/**
 * §18.3 against a **real** process tree: `sh -c 'sleep 30 & sleep 30 & wait'`.
 *
 * Every test asserts the kernel's own view (`ps -o stat=` → `T` for stopped) rather than our
 * bookkeeping, because the whole point of the safety invariants is that a bug here leaves a
 * user's session frozen.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../../src/config.js';
import {
  descendantsOf,
  FreezeRefused,
  freezeTree,
  listProcesses,
  parseProcessTable,
  resumeAll,
  thaw,
} from '../../src/pause/freeze.js';
import { createSessionsSubsystem } from '../../src/sessions/index.js';
import { sessionsFilePath } from '../../src/sessions/registry.js';
import { pauseFilePath } from '../../src/pause/rules.js';
import { tempDir } from '../sessions/helpers.js';

const children: ChildProcess[] = [];

function spawnTree(): ChildProcess {
  const child = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isStopped(pid: number): boolean {
  return statOf(pid).startsWith('T');
}

/**
 * Wait until `pid` has at least `count` descendants, returning **only** the descendants —
 * a hard freeze stops the tool subprocesses and never the session's own process (§23.16).
 */
async function toolsOf(pid: number, count = 2): Promise<number[]> {
  for (let i = 0; i < 60; i += 1) {
    const kids = descendantsOf(pid, listProcesses());
    if (kids.length >= count) return kids;
    await sleep(50);
  }
  throw new Error(`process ${pid} never spawned ${count} children`);
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterEach(() => {
  for (const child of children.splice(0)) {
    const pid = child.pid;
    if (pid === undefined) continue;
    const tree = [pid, ...descendantsOf(pid, listProcesses())];
    // Always SIGCONT before SIGKILL: a stopped process never reaps its kill.
    thaw(tree);
    for (const p of tree) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

describe('process table parsing', () => {
  it('parses `ps -axo pid=,ppid=` output', () => {
    expect(parseProcessTable('  501   1\n 1234 501\nnot a row\n')).toEqual([
      { pid: 501, ppid: 1 },
      { pid: 1234, ppid: 501 },
    ]);
  });

  it('walks a tree breadth-first without looping', () => {
    const table = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 1 },
      { pid: 4, ppid: 2 },
    ];
    expect(descendantsOf(1, table)).toEqual([2, 3, 4]);
    expect(descendantsOf(4, table)).toEqual([]);
  });

  it('sees the real machine', () => {
    expect(listProcesses().length).toBeGreaterThan(1);
  });
});

describe('freeze and thaw a real tree (§18.3)', () => {
  it('SIGSTOPs the tool subprocesses and leaves the session itself runnable (§23.16)', async () => {
    const child = spawnTree();
    const tools = await toolsOf(child.pid as number);
    expect(tools.length).toBeGreaterThanOrEqual(2);

    const frozen = freezeTree(child.pid as number);
    expect(frozen).toEqual(tools);
    expect(frozen).not.toContain(child.pid);
    await waitFor(() => frozen.every(isStopped), 'the tool subprocesses to stop');
    // The root keeps its terminal: SIGSTOP here is what makes zsh print "suspended" and
    // demand an `fg` after the resume.
    expect(isStopped(child.pid as number)).toBe(false);

    thaw(frozen);
    await waitFor(() => frozen.every((p) => !isStopped(p)), 'the tool subprocesses to resume');
  });

  it('freezes an idle session to an empty list rather than stopping it (§23.16)', () => {
    // `sleep` with no children: nothing below it, so nothing to stop. The session is held at
    // the PreToolUse gate instead, and it must not read as "never frozen".
    const idle = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(idle);
    expect(freezeTree(idle.pid as number)).toEqual([]);
    expect(isStopped(idle.pid as number)).toBe(false);
  });

  it('ignores ESRCH for pids that already exited', () => {
    // A pid that cannot exist: thaw must not throw.
    expect(() => thaw([2_147_483_646])).not.toThrow();
    expect(thaw([2_147_483_646])).toEqual([]);
  });

  it('refuses a pid we do not own', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    // pid 1 belongs to root everywhere we run.
    expect(() => freezeTree(1)).toThrow(FreezeRefused);
    try {
      freezeTree(1);
    } catch (err) {
      expect((err as FreezeRefused).reason).toBe('foreign_uid');
    }
  });

  it('refuses a session with no pid', () => {
    expect(() => freezeTree(null)).toThrow(/no trusted pid/);
  });
});

describe('safety invariants (§18.3)', () => {
  it('SIGCONTs every frozen pid when the daemon shuts down', async () => {
    const configDir = tempDir('cu-freeze-');
    const child = spawnTree();
    const tools = await toolsOf(child.pid as number);
    const subsystem = createSessionsSubsystem({ configDir });
    subsystem.start();
    subsystem.registry.register({ sessionId: 's', pid: child.pid as number, cwd: '/tmp' });
    const outcome = subsystem.pause.pause({ scope: 'session:s', mode: 'hard', reason: 'stop', createdBy: 'cli' });
    expect(outcome.ok).toBe(true);
    await waitFor(() => tools.every(isStopped), 'the tool subprocesses to stop');
    expect(subsystem.registry.get('s')?.freezes).toBe(1);

    subsystem.stop();
    await waitFor(() => tools.every((p) => !isStopped(p)), 'shutdown to resume the tools');
  });

  it('resumes with no daemon at all — `claude-usage resume --all`', async () => {
    const configDir = tempDir('cu-freeze-');
    const child = spawnTree();
    const tools = await toolsOf(child.pid as number);
    const frozen = freezeTree(child.pid as number);
    await waitFor(() => tools.every(isStopped), 'the tool subprocesses to stop');

    // Exactly what a daemon would have left behind on disk.
    writeJsonFile(sessionsFilePath(configDir), {
      version: 1,
      rev: 7,
      sessions: [
        {
          sessionId: 's',
          pid: child.pid,
          cwd: '/tmp',
          transcriptPath: null,
          gitCommonDir: null,
          source: null,
          registeredAt: '2026-09-13T12:00:00.000Z',
          lastActivityAt: '2026-09-13T12:00:00.000Z',
          alive: true,
          deadSince: null,
          frozenPids: frozen,
          frozenPid: child.pid,
          freezes: 1,
          pausedSince: '2026-09-13T12:00:00.000Z',
          lastTool: null,
        },
      ],
    });
    writeJsonFile(pauseFilePath(configDir), {
      version: 1,
      rules: [{ id: 'r_x', scope: 'session:s', mode: 'hard', reason: '', createdAt: '2026-09-13T12:00:00.000Z', createdBy: 'cli' }],
    });

    const result = resumeAll(configDir);
    expect(result.removed).toEqual(['r_x']);
    expect(result.resumed.length).toBe(frozen.length);
    await waitFor(() => tools.every((p) => !isStopped(p)), 'offline resume to thaw the tools');

    const rules = JSON.parse(execFileSync('cat', [pauseFilePath(configDir)], { encoding: 'utf8' })) as { rules: unknown[] };
    expect(rules.rules).toEqual([]);
  });

  it('orphan sweep: SIGCONTs pids whose rule is gone, re-freezes ones still matching', async () => {
    const configDir = tempDir('cu-freeze-');
    const orphan = spawnTree();
    const kept = spawnTree();
    const orphanTools = await toolsOf(orphan.pid as number);
    const keptTools = await toolsOf(kept.pid as number);

    const orphanFrozen = freezeTree(orphan.pid as number);
    await waitFor(() => orphanTools.every(isStopped), 'the orphan tools to stop');

    writeJsonFile(sessionsFilePath(configDir), {
      version: 1,
      rev: 3,
      sessions: [
        {
          sessionId: 'orphan',
          pid: orphan.pid,
          cwd: '/tmp',
          transcriptPath: null,
          gitCommonDir: null,
          source: null,
          registeredAt: '2026-09-13T12:00:00.000Z',
          lastActivityAt: '2026-09-13T12:00:00.000Z',
          alive: true,
          deadSince: null,
          frozenPids: orphanFrozen,
          frozenPid: orphan.pid,
          freezes: 1,
          pausedSince: '2026-09-13T12:00:00.000Z',
          lastTool: null,
        },
        {
          sessionId: 'kept',
          pid: kept.pid,
          cwd: '/tmp',
          transcriptPath: null,
          gitCommonDir: null,
          source: null,
          registeredAt: '2026-09-13T12:00:00.000Z',
          lastActivityAt: '2026-09-13T12:00:00.000Z',
          alive: true,
          deadSince: null,
          // Stale pids from before the restart: the sweep must re-resolve the tree.
          frozenPids: [kept.pid as number],
          frozenPid: kept.pid,
          freezes: 1,
          pausedSince: '2026-09-13T12:00:00.000Z',
          lastTool: null,
        },
      ],
    });
    writeJsonFile(pauseFilePath(configDir), {
      version: 1,
      rules: [{ id: 'r_keep', scope: 'session:kept', mode: 'hard', reason: '', createdAt: '2026-09-13T12:00:00.000Z', createdBy: 'cli' }],
    });

    const subsystem = createSessionsSubsystem({ configDir });
    subsystem.start();
    try {
      await waitFor(() => orphanTools.every((p) => !isStopped(p)), 'the orphan tools to be resumed');
      await waitFor(() => keptTools.every(isStopped), 'the still-matching tools to be re-frozen');
      expect(subsystem.registry.get('kept')?.frozenPids.length).toBe(keptTools.length);
      // A restart sweep is a second freeze, and the dashboard can see that (§23.16).
      expect(subsystem.registry.get('kept')?.freezes).toBe(2);
    } finally {
      subsystem.stop();
    }
    await waitFor(() => keptTools.every((p) => !isStopped(p)), 'shutdown to resume the kept tools');
  });
});
