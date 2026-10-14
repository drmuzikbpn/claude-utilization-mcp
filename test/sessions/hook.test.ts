// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/** The hook's §17.1 dispatch and §18.2 gate, against a real server + sessions subsystem. */

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/clients/http.js';
import {
  detectGitCommonDir,
  gateSleep,
  GATE_DEADLINE_MS,
  GATE_FAILURE_TOLERANCE,
  HOOK_DEADLINE_MS,
  pausedMarkerPath,
  runGate,
  runHook,
  type HookIO,
} from '../../src/hook.js';
import type { UsageServer } from '../../src/server/index.js';
import { makeHarness, startHarnessServer, type Harness } from './helpers.js';

let h: Harness;
let server: UsageServer;
let client: DaemonClient;
let printed: string;

beforeEach(async () => {
  // The hook reports pid 4242: a `claude` process of ours in the fake table, so it is trusted (§23.56).
  h = makeHarness({ table: [{ pid: 4242, ppid: 1 }] });
  const started = await startHarnessServer(h);
  server = started.server;
  client = new DaemonClient({ baseUrl: `http://127.0.0.1:${started.port}`, timeoutMs: 1_000, token: 'test-bearer-token' });
  printed = '';
});

afterEach(async () => {
  h.subsystem.stop();
  await server.close();
});

function io(over: Partial<HookIO> & { stdin: string }): HookIO {
  return {
    client,
    configDir: h.configDir,
    stdout: (t: string) => {
      printed += t;
    },
    deadlineMs: 1_000,
    now: () => h.clock.now,
    gatePollMs: 1,
    gateMaxMs: 5_000,
    ppid: 4242,
    gitCommonDir: () => '/tmp/x/foo/.git',
    ...over,
  };
}

const START = JSON.stringify({
  hook_event_name: 'SessionStart',
  session_id: '11111111-1111-4111-8111-111111111111',
  cwd: '/tmp/x/foo',
  transcript_path: '/tmp/t/11111111-1111-4111-8111-111111111111.jsonl',
  source: 'startup',
});

describe('SessionStart (§17.1)', () => {
  it('registers the session with ppid, cwd, transcript and the repo dir', async () => {
    expect(await runHook(io({ stdin: START }))).toBe(0);
    const session = h.subsystem.registry.get('11111111-1111-4111-8111-111111111111');
    expect(session).toMatchObject({
      sessionId: '11111111-1111-4111-8111-111111111111',
      pid: 4242,
      cwd: '/tmp/x/foo',
      transcriptPath: '/tmp/t/11111111-1111-4111-8111-111111111111.jsonl',
      gitCommonDir: '/tmp/x/foo/.git',
      source: 'startup',
    });
    expect(printed).toBe('');
  });

  it('registers with gitCommonDir null outside a repository', async () => {
    await runHook(io({ stdin: START, gitCommonDir: () => null }));
    expect(h.subsystem.registry.get('11111111-1111-4111-8111-111111111111')?.gitCommonDir).toBeNull();
    expect(h.subsystem.registry.viewOf('11111111-1111-4111-8111-111111111111')?.project).toEqual({ gitCommonDir: null, name: 'foo' });
  });

  it('does nothing without a session id', async () => {
    expect(await runHook(io({ stdin: JSON.stringify({ hook_event_name: 'SessionStart' }) }))).toBe(0);
    expect(h.subsystem.registry.all()).toEqual([]);
  });

  it('probes the repository with a 2 s deadline and never throws', () => {
    expect(detectGitCommonDir('/nonexistent-dir-for-tests')).toBeNull();
    expect(detectGitCommonDir('')).toBeNull();
    const here = detectGitCommonDir(process.cwd());
    if (here !== null) expect(here.startsWith('/')).toBe(true);
  });
});

describe('SessionEnd (§17.1)', () => {
  it('ends the session and clears its paused marker', async () => {
    await runHook(io({ stdin: START }));
    await runHook(io({ stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: '11111111-1111-4111-8111-111111111111' }) }));
    expect(h.subsystem.registry.get('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(existsSync(pausedMarkerPath(h.configDir, '11111111-1111-4111-8111-111111111111'))).toBe(false);
    expect(printed).toBe('');
  });
});

describe('UserPromptSubmit (§17.1, §7.1)', () => {
  it('heartbeats, gates and still prints the nudge', async () => {
    await runHook(io({ stdin: START }));
    const before = h.subsystem.registry.get('11111111-1111-4111-8111-111111111111')?.lastActivityAt;
    h.clock.now += 30_000;

    const code = await runHook(
      io({ stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: '11111111-1111-4111-8111-111111111111', cwd: '/tmp/x/foo' }) }),
    );
    expect(code).toBe(0);
    expect(h.subsystem.registry.get('11111111-1111-4111-8111-111111111111')?.lastActivityAt).not.toBe(before);
    // The fixture snapshot is over the warn threshold, so the nudge prints.
    expect(printed).toContain('Claude usage');
  });
});

describe('PreToolUse (§23.13)', () => {
  it('records the tool through the gate and prints nothing', async () => {
    await runHook(io({ stdin: START }));
    const code = await runHook(
      io({ stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '11111111-1111-4111-8111-111111111111', tool_name: 'Edit' }) }),
    );
    expect(code).toBe(0);
    expect(h.subsystem.registry.get('11111111-1111-4111-8111-111111111111')?.lastTool?.name).toBe('Edit');
    expect(printed).toBe('');
  });
});

describe('the soft-pause gate (§18.2)', () => {
  it('sleeps and re-polls while paused, then releases', async () => {
    await runHook(io({ stdin: START }));
    h.subsystem.pause.pause({ scope: 'all', mode: 'soft', reason: 'dinner', createdBy: 'dashboard' });

    let sleeps = 0;
    const code = await runHook(
      io({
        stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '11111111-1111-4111-8111-111111111111', tool_name: 'Bash' }),
        sleep: async () => {
          sleeps += 1;
          // Marker exists for the status line while the gate holds the session.
          expect(existsSync(pausedMarkerPath(h.configDir, '11111111-1111-4111-8111-111111111111'))).toBe(true);
          if (sleeps === 3) h.subsystem.pause.resume('all');
        },
      }),
    );

    expect(code).toBe(0);
    expect(sleeps).toBe(3);
    expect(existsSync(pausedMarkerPath(h.configDir, '11111111-1111-4111-8111-111111111111'))).toBe(false);
  });

  it('writes the rule into the marker file', async () => {
    await runHook(io({ stdin: START }));
    h.subsystem.pause.pause({ scope: 'session:11111111-1111-4111-8111-111111111111', mode: 'soft', reason: 'stop', createdBy: 'cli' });
    let seen = '';
    await runHook(
      io({
        stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '11111111-1111-4111-8111-111111111111' }),
        sleep: async () => {
          seen = readFileSync(pausedMarkerPath(h.configDir, '11111111-1111-4111-8111-111111111111'), 'utf8');
          h.subsystem.pause.resume('session:11111111-1111-4111-8111-111111111111');
        },
      }),
    );
    expect(JSON.parse(seen)).toMatchObject({ mode: 'soft', reason: 'stop' });
  });

  it('gives up at gateMaxMs rather than blocking forever', async () => {
    await runHook(io({ stdin: START }));
    h.subsystem.pause.pause({ scope: 'all', mode: 'soft', createdBy: 'cli' });
    let sleeps = 0;
    const code = await runHook(
      io({
        stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '11111111-1111-4111-8111-111111111111' }),
        gateMaxMs: 2_000,
        sleep: async () => {
          sleeps += 1;
          h.clock.now += 1_000;
        },
      }),
    );
    expect(code).toBe(0);
    expect(sleeps).toBe(2);
    expect(existsSync(pausedMarkerPath(h.configDir, '11111111-1111-4111-8111-111111111111'))).toBe(false);
  });
});

describe('fail open (§18.2, §10)', () => {
  it('treats an unreachable daemon as not paused and still exits 0', async () => {
    const dead = new DaemonClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 50 });
    let sleeps = 0;
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse']) {
      const code = await runHook(
        io({
          stdin: JSON.stringify({ hook_event_name: event, session_id: '11111111-1111-4111-8111-111111111111', cwd: '/tmp/x/foo' }),
          client: dead,
          sleep: async () => {
            sleeps += 1;
          },
        }),
      );
      expect(code).toBe(0);
    }
    expect(sleeps).toBe(0);
    expect(printed).toBe('');
  });

  it('exits 0 on malformed stdin and unknown events', async () => {
    expect(await runHook(io({ stdin: 'not json' }))).toBe(0);
    expect(await runHook(io({ stdin: JSON.stringify({ hook_event_name: 'Notification' }) }))).toBe(0);
  });
});

describe('gate robustness (QA findings on v0.1.65)', () => {
  it('does not unref its sleep timer — an unref\'d timer lets node exit mid-sleep and the tool runs anyway', async () => {
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      timers.push(t);
      return t;
    }) as typeof globalThis.setTimeout);
    try {
      await gateSleep(1);
    } finally {
      spy.mockRestore();
    }
    // gateSleep's timer is the first one created after the spy is installed (the executor
    // runs synchronously); other timers may come from the runtime.
    expect(timers.length).toBeGreaterThanOrEqual(1);
    // hasRef() === false is exactly the bug: node exits while the hook is "sleeping".
    expect(timers[0]?.hasRef()).toBe(true);
  });

  it('polls the gate with its own deadline, not the 200 ms nudge budget', async () => {
    const seen: Array<number | undefined> = [];
    const spyClient = {
      get: async (path: string, opts?: { timeoutMs?: number }) => {
        seen.push(opts?.timeoutMs);
        if (path.includes('/gate')) return { paused: false, mode: null, ruleId: null, reason: null };
        throw new Error('unreachable');
      },
    };
    await runGate(spyClient, '11111111-1111-4111-8111-111111111111', 'Bash', { now: () => h.clock.now }, h.configDir);
    expect(seen).toEqual([GATE_DEADLINE_MS]);
    expect(GATE_DEADLINE_MS).toBeGreaterThan(HOOK_DEADLINE_MS);
  });

  it('rides out transient poll failures while paused, and fails open once they persist', async () => {
    let call = 0;
    const flaky = {
      get: async () => {
        call += 1;
        if (call === 1) return { paused: true, mode: 'soft', ruleId: 'r_1', reason: 'usage-deck' };
        throw new Error('ETIMEDOUT');
      },
    };
    const paused = await runGate(
      flaky,
      '11111111-1111-4111-8111-111111111111',
      undefined,
      { now: () => h.clock.now, sleep: async () => {}, gateMaxMs: 5_000 },
      h.configDir,
    );
    expect(paused).toBe(true);
    // One paused poll, then GATE_FAILURE_TOLERANCE failures before releasing.
    expect(call).toBe(1 + GATE_FAILURE_TOLERANCE);
    expect(existsSync(pausedMarkerPath(h.configDir, '11111111-1111-4111-8111-111111111111'))).toBe(false);
  });
});
