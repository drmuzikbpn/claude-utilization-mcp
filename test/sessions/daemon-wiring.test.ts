/** The daemon's single W3 wiring block: shared bus, subsystem, SIGCONT on shutdown. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon } from '../../src/daemon.js';
import { descendantsOf, listProcesses, thaw } from '../../src/pause/freeze.js';
import { testConfig } from '../helpers/fakes.js';
import { tempDir } from './helpers.js';

const spawned: ChildProcess[] = [];

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopped(pid: number): boolean {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('T');
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    const pid = child.pid;
    if (pid === undefined) continue;
    const tree = [pid, ...descendantsOf(pid, listProcesses())];
    thaw(tree);
    for (const p of tree) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
});

describe('startDaemon + sessions', () => {
  it('serves /v1/sessions and publishes on the shared bus', async () => {
    const configDir = tempDir('cu-daemon-');
    const handle = await startDaemon({ configDir, config: testConfig({ port: 0 }), tokens: null, poll: false, port: 0 });
    try {
      expect(handle.sessions).not.toBeNull();
      const seen: string[] = [];
      handle.bus.subscribe('session', (payload) => seen.push(payload.type));

      const registered = await fetch(`http://127.0.0.1:${handle.port}/v1/sessions/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1', pid: process.pid, cwd: '/tmp/x/foo' }),
      });
      expect(registered.status).toBe(200);
      expect(seen).toEqual(['start']);

      const listed = await fetch(`http://127.0.0.1:${handle.port}/v1/sessions`);
      const body = (await listed.json()) as { rev: number; sessions: { sessionId: string }[] };
      expect(body.sessions.map((s) => s.sessionId)).toEqual(['sess-1']);
      expect(listed.headers.get('etag')).toBe(`W/"${body.rev}"`);
    } finally {
      await handle.stop();
    }
  });

  it('SIGCONTs a hard-frozen tree when the daemon stops (§18.3)', async () => {
    const configDir = tempDir('cu-daemon-');
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], { stdio: 'ignore' });
    spawned.push(child);
    const pid = child.pid as number;
    for (let i = 0; i < 40 && descendantsOf(pid, listProcesses()).length < 2; i += 1) await sleepMs(50);
    // Only the tool subprocesses are ever stopped — the `claude` process keeps its terminal.
    const tools = descendantsOf(pid, listProcesses());

    const handle = await startDaemon({ configDir, config: testConfig({ port: 0 }), tokens: null, poll: false, port: 0 });
    handle.sessions?.registry.register({ sessionId: 'sess-1', pid, cwd: '/tmp' });
    const outcome = handle.sessions?.pause.pause({ scope: 'session:sess-1', mode: 'hard', reason: '', createdBy: 'cli' });
    expect(outcome?.ok).toBe(true);
    for (let i = 0; i < 40 && !tools.every(stopped); i += 1) await sleepMs(50);
    expect(tools.every(stopped)).toBe(true);
    expect(stopped(pid)).toBe(false);

    await handle.stop();
    for (let i = 0; i < 40 && tools.some(stopped); i += 1) await sleepMs(50);
    expect(tools.some(stopped)).toBe(false);
  });
});
