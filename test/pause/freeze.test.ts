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

/** Wait until `pid` has at least `count` descendants, returning the tree parent-first. */
async function treeOf(pid: number, count = 2): Promise<number[]> {
  for (let i = 0; i < 60; i += 1) {
    const kids = descendantsOf(pid, listProcesses());
    if (kids.length >= count) return [pid, ...kids];
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
  it('SIGSTOPs children then the parent, and SIGCONTs on resume', async () => {
    const child = spawnTree();
    const tree = await treeOf(child.pid as number);
    expect(tree.length).toBeGreaterThanOrEqual(3);

    const frozen = freezeTree(child.pid as number);
    expect(frozen[0]).toBe(child.pid);
    expect(frozen.length).toBe(tree.length);
    await waitFor(() => frozen.every(isStopped), 'the whole tree to stop');

    thaw(frozen);
    await waitFor(() => frozen.every((p) => !isStopped(p)), 'the whole tree to resume');
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
    const tree = await treeOf(child.pid as number);
    const subsystem = createSessionsSubsystem({ configDir });
    subsystem.start();
    subsystem.registry.register({ sessionId: 's', pid: child.pid as number, cwd: '/tmp' });
    const outcome = subsystem.pause.pause({ scope: 'session:s', mode: 'hard', reason: 'stop', createdBy: 'cli' });
    expect(outcome.ok).toBe(true);
    await waitFor(() => tree.every(isStopped), 'the tree to stop');

    subsystem.stop();
    await waitFor(() => tree.every((p) => !isStopped(p)), 'shutdown to resume the tree');
  });

  it('resumes with no daemon at all — `claude-usage resume --all`', async () => {
    const configDir = tempDir('cu-freeze-');
    const child = spawnTree();
    const tree = await treeOf(child.pid as number);
    const frozen = freezeTree(child.pid as number);
    await waitFor(() => tree.every(isStopped), 'the tree to stop');

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
    await waitFor(() => tree.every((p) => !isStopped(p)), 'offline resume to thaw the tree');

    const rules = JSON.parse(execFileSync('cat', [pauseFilePath(configDir)], { encoding: 'utf8' })) as { rules: unknown[] };
    expect(rules.rules).toEqual([]);
  });

  it('orphan sweep: SIGCONTs pids whose rule is gone, re-freezes ones still matching', async () => {
    const configDir = tempDir('cu-freeze-');
    const orphan = spawnTree();
    const kept = spawnTree();
    const orphanTree = await treeOf(orphan.pid as number);
    const keptTree = await treeOf(kept.pid as number);

    const orphanFrozen = freezeTree(orphan.pid as number);
    await waitFor(() => orphanTree.every(isStopped), 'the orphan tree to stop');

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
      await waitFor(() => orphanTree.every((p) => !isStopped(p)), 'the orphan tree to be resumed');
      await waitFor(() => keptTree.every(isStopped), 'the still-matching tree to be re-frozen');
      expect(subsystem.registry.get('kept')?.frozenPids.length).toBe(keptTree.length);
    } finally {
      subsystem.stop();
    }
    await waitFor(() => keptTree.every((p) => !isStopped(p)), 'shutdown to resume the kept tree');
  });
});
