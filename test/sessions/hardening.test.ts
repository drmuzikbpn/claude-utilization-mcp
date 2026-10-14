// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/** §23.56: what a token holder can still do through the session endpoints, and cannot. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../../src/config.js';
import { crashHandler } from '../../src/crash.js';
import { daemonFilePath } from '../../src/clients/http.js';
import { PortInUseError, startDaemon } from '../../src/daemon.js';
import {
  ancestorsOf,
  freezeTree,
  inspectProcesses,
  isClaudeCodeCommand,
  parsePsIdentities,
  protectedPids,
  readBootId,
  resumeAll,
  thaw,
  thawRecorded,
  FreezeRefused,
  type FrozenProc,
} from '../../src/pause/freeze.js';
import { pauseFilePath } from '../../src/pause/rules.js';
import { sessionsFilePath } from '../../src/sessions/registry.js';
import {
  checkRegistration,
  cleanToolName,
  isInside,
  isSessionId,
  MAX_PATH_CHARS,
  MAX_SESSIONS,
  MAX_TOOL_CHARS,
  PIDLESS_SESSION_TTL_MS,
} from '../../src/sessions/validate.js';
import type { UsageServer } from '../../src/server/index.js';
import { testConfig } from '../helpers/fakes.js';
import { authFetch } from '../helpers/raw-request.js';
import { fakeFreezeDeps, makeHarness, startHarnessServer, tempDir, type Harness, type HarnessOptions, type RecordedSignal } from './helpers.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** claude (4242) ← zsh (4250) ← two tools; the daemon (7000) lives elsewhere. */
const TREE = [
  { pid: 4242, ppid: 1 },
  { pid: 4250, ppid: 4242 },
  { pid: 4251, ppid: 4250 },
  { pid: 4252, ppid: 4250 },
  { pid: 7000, ppid: 1 },
];

const servers: UsageServer[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.subsystem.stop();
  for (const s of servers.splice(0)) await s.close();
});

async function serve(over: HarnessOptions = {}): Promise<{ h: Harness; base: string }> {
  const h = makeHarness(over);
  harnesses.push(h);
  const started = await startHarnessServer(h);
  servers.push(started.server);
  return { h, base: `http://127.0.0.1:${started.port}` };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function reg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId: S1, pid: 4242, cwd: '/tmp/x/foo', transcriptPath: `/tmp/t/${S1}.jsonl`, gitCommonDir: '/tmp/x/foo/.git', source: 'startup', ...over };
}

describe('session ids', () => {
  it.each(['../../etc', 'sess-1', '', 'a'.repeat(36), `${S1}/..`, `${S1} `, `${S1}\n`, '11111111111141118111111111111111', '%2e%2e', 'g1111111-1111-4111-8111-111111111111'])(
    'refuses "%s"',
    (id) => {
      expect(isSessionId(id)).toBe(false);
    },
  );

  it('accepts what Claude Code sends, in either case', () => {
    expect(isSessionId(S1)).toBe(true);
    expect(isSessionId('C0FFEE00-1234-4ABC-9DEF-0123456789AB')).toBe(true);
    expect(isSessionId(42)).toBe(false);
  });

  it('register refuses a malformed id and registers nothing', async () => {
    const { h, base } = await serve({ table: TREE });
    for (const sessionId of ['../../../tmp/x', 'sess-1', 'a/b', '', 7]) {
      const res = await post(base, '/v1/sessions/register', reg({ sessionId }));
      expect(res.status, String(sessionId)).toBe(400);
      expect(String((res.body['error'] as { message: string }).message)).toContain('sessionId');
    }
    expect(h.subsystem.registry.all()).toEqual([]);
  });

  it.each(['gate', 'heartbeat', 'end', 'pause', 'resume'])('…/%s refuses a path id that is not a UUID', async (action) => {
    const { h, base } = await serve({ table: TREE });
    const path = `/v1/sessions/${encodeURIComponent('../x')}/${action}`;
    const res = action === 'gate' ? await authFetch(`${base}${path}`) : await authFetch(`${base}${path}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(h.subsystem.rules.list()).toEqual([]);
  });
});

describe('registration fields', () => {
  it.each([
    ['cwd', 'relative/dir'],
    ['cwd', `/${'a'.repeat(MAX_PATH_CHARS)}`],
    ['cwd', '/tmp/with\u0000nul'],
    ['cwd', 42],
    ['transcriptPath', '../t.jsonl'],
    ['transcriptPath', '/tmp/t/not-a-transcript.txt'],
    ['gitCommonDir', '.git'],
    ['source', 'x'.repeat(65)],
    ['source', 'two words'],
    ['pid', '4242'],
    ['pid', 1],
    ['pid', -4],
    ['pid', 4.5],
    ['pid', 2 ** 31],
  ])('refuses %s = %j', async (field, value) => {
    const check = checkRegistration(reg({ [field]: value }));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.field).toBe(field);
    const { h, base } = await serve({ table: TREE });
    expect((await post(base, '/v1/sessions/register', reg({ [field]: value }))).status).toBe(400);
    expect(h.subsystem.registry.all()).toEqual([]);
  });

  it('accepts the hook payload, with nulls and absences where the hook has nothing', () => {
    expect(checkRegistration(reg())).toMatchObject({ ok: true, value: { sessionId: S1, pid: 4242, cwd: '/tmp/x/foo' } });
    expect(checkRegistration({ sessionId: S1 })).toEqual({
      ok: true,
      value: { sessionId: S1, pid: null, cwd: '', transcriptPath: null, gitCommonDir: null, source: null },
    });
    expect(checkRegistration(reg({ transcriptPath: null, gitCommonDir: null, source: null, pid: null }))).toMatchObject({ ok: true });
  });

  it('only believes a transcript path inside the configured projects directory', async () => {
    const root = tempDir('cu-projects-');
    const { h, base } = await serve({ table: TREE, transcriptRoots: [root] });
    await post(base, '/v1/sessions/register', reg({ transcriptPath: '/tmp/elsewhere/t.jsonl' }));
    expect(h.subsystem.registry.get(S1)?.transcriptPath).toBeNull();
    await post(base, '/v1/sessions/register', reg({ sessionId: S2, transcriptPath: join(root, 'p', `${S2}.jsonl`) }));
    expect(h.subsystem.registry.get(S2)?.transcriptPath).toBe(join(root, 'p', `${S2}.jsonl`));
    await post(base, '/v1/sessions/register', reg({ sessionId: S3, transcriptPath: `${root}/../outside/t.jsonl` }));
    expect(h.subsystem.registry.get(S3)?.transcriptPath).toBeNull();
    expect(isInside('/a/b', '/a/bc/t')).toBe(false);
    expect(isInside('/a/b', '/a/b/c/t')).toBe(true);
  });

  it('bounds the tool name the gate records, and GET never records one', async () => {
    const { h, base } = await serve({ table: TREE });
    await post(base, '/v1/sessions/register', reg());
    expect((await authFetch(`${base}/v1/sessions/${S1}/gate?tool=Bash`)).status).toBe(200);
    expect(h.subsystem.registry.get(S1)?.lastTool).toBeNull();
    await post(base, `/v1/sessions/${S1}/gate`, { tool: 'x'.repeat(MAX_TOOL_CHARS + 1) });
    expect(h.subsystem.registry.get(S1)?.lastTool).toBeNull();
    const gate = await post(base, `/v1/sessions/${S1}/gate`, { tool: 'Bash' });
    expect(gate.body).toEqual({ paused: false, mode: null, ruleId: null, reason: null });
    expect(h.subsystem.registry.get(S1)?.lastTool?.name).toBe('Bash');
    expect(cleanToolName('a\u0007b')).toBeUndefined();
    expect(cleanToolName(7)).toBeUndefined();
  });

  it('refuses an over-long pause scope without echoing it', async () => {
    const { base } = await serve({ table: TREE });
    const scope = `project:/${'a'.repeat(MAX_PATH_CHARS + 100)}`;
    const res = await authFetch(`${base}/v1/pause`, { method: 'POST', body: JSON.stringify({ scope, mode: 'soft' }) });
    expect(res.status).toBe(400);
    expect((await res.text()).length).toBeLessThan(500);
  });
});

describe('which pid a session may have', () => {
  it.each([
    ['claude', true],
    ['claude --resume', true],
    ['/opt/homebrew/bin/claude -p hello', true],
    ['/home/alice/.local/share/claude/versions/2.1.0 --print', true],
    ['node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', true],
    ['/usr/bin/node /home/alice/.npm/lib/node_modules/@anthropic-ai/claude-code/dist/cli.mjs --continue', true],
    ['claude-usage serve', false],
    ['/usr/local/bin/claude-usage hook', false],
    ['/bin/zsh -c claude', false],
    ['vim claude', false],
    ['node /tmp/claude-code/cli.js', false],
    ['sleep 30', false],
    ['', false],
    ['Claude', false],
  ])('isClaudeCodeCommand(%j) is %s', (command, expected) => {
    expect(isClaudeCodeCommand(command)).toBe(expected);
  });

  it('keeps the pid of a Claude Code process of ours, with its start time', async () => {
    const { h, base } = await serve({ table: TREE });
    const res = await post(base, '/v1/sessions/register', reg());
    expect(res.status).toBe(200);
    expect(h.subsystem.registry.get(S1)).toMatchObject({ pid: 4242, pidStart: 'start-4242' });
  });

  it('registers the session without a pid when the process is not Claude Code', async () => {
    const { h, base } = await serve({ table: TREE, commands: { 4242: '/usr/bin/some-editor notes.txt' } });
    const res = await post(base, '/v1/sessions/register', reg());
    expect(res.status).toBe(200);
    expect(h.subsystem.registry.get(S1)).toMatchObject({ pid: null, pidStart: null });
    // …and so there is nothing a hard freeze could be pointed at.
    const hard = await post(base, `/v1/sessions/${S1}/pause`, { mode: 'hard' });
    expect(hard.status).toBe(410);
    expect(h.signals).toEqual([]);
    expect(h.subsystem.rules.list()).toEqual([]);
  });

  it('refuses a pid owned by someone else, and one that does not exist', async () => {
    const { h, base } = await serve({ table: TREE, uids: { 4242: 0 } });
    await post(base, '/v1/sessions/register', reg());
    expect(h.subsystem.registry.get(S1)?.pid).toBeNull();
    await post(base, '/v1/sessions/register', reg({ sessionId: S2, pid: 31337 }));
    expect(h.subsystem.registry.get(S2)?.pid).toBeNull();
  });

  it('walks up from a hook that was started through a shell to the Claude Code process above it', async () => {
    const table = [...TREE, { pid: 4300, ppid: 4242 }];
    const { h, base } = await serve({ table, commands: { 4300: '/bin/sh -c claude-usage hook' } });
    await post(base, '/v1/sessions/register', reg({ pid: 4300 }));
    expect(h.subsystem.registry.get(S1)).toMatchObject({ pid: 4242, pidStart: 'start-4242' });
  });

  it('does not walk up for ever: a Claude Code process too far above is not adopted', () => {
    const table = [
      { pid: 10, ppid: 1 },
      ...[11, 12, 13, 14, 15, 16].map((pid) => ({ pid, ppid: pid - 1 })),
    ];
    const commands: Record<number, string> = { 11: 'sh', 12: 'sh', 13: 'sh', 14: 'sh', 15: 'sh', 16: 'sh' };
    const h = makeHarness({ table, commands });
    harnesses.push(h);
    expect(h.subsystem.pause.trustPid(16)).toBeNull();
    expect(h.subsystem.pause.trustPid(14)).toEqual({ pid: 10, start: 'start-10' });
    expect(h.subsystem.pause.trustPid(1)).toBeNull();
    expect(h.subsystem.pause.trustPid(null)).toBeNull();
  });
});

describe('a pid is only the same process while its start time matches', () => {
  it('a recycled pid reads as dead at the next liveness sweep', async () => {
    const starts: Record<number, string> = {};
    const { h, base } = await serve({ table: TREE, starts });
    await post(base, '/v1/sessions/register', reg());
    h.alive.add(4242);
    expect(h.subsystem.registry.checkLiveness().died).toEqual([]);
    starts[4242] = 'another-process';
    expect(h.subsystem.registry.checkLiveness().died.map((s) => s.sessionId)).toEqual([S1]);
    expect(h.subsystem.registry.get(S1)?.alive).toBe(false);
  });

  it('a hard pause on a session whose pid was recycled is refused and signals nothing', async () => {
    const starts: Record<number, string> = {};
    const { h, base } = await serve({ table: TREE, starts });
    await post(base, '/v1/sessions/register', reg());
    h.alive.add(4242);
    starts[4242] = 'another-process';
    const res = await post(base, `/v1/sessions/${S1}/pause`, { mode: 'hard' });
    expect(res.status).toBe(410);
    expect(h.signals).toEqual([]);
  });

  it('freezeTree refuses a root whose start time changed', () => {
    const deps = fakeFreezeDeps(TREE, { starts: { 4242: 'now-someone-else' } });
    expect(() => freezeTree(4242, deps, { expectStart: 'start-4242' })).toThrow(FreezeRefused);
    expect(deps.signals).toEqual([]);
    expect(freezeTree(4242, deps, { expectStart: 'now-someone-else' })).toEqual([4250, 4251, 4252]);
  });

  it('thaw skips a recycled pid, a foreign one and a missing one, and resumes the rest', () => {
    const deps = fakeFreezeDeps(TREE, { starts: { 4251: 'recycled' }, uids: { 4252: 0 } });
    const recorded: FrozenProc[] = [
      { pid: 4250, start: 'start-4250' },
      { pid: 4251, start: 'start-4251' },
      { pid: 4252, start: 'start-4252' },
      { pid: 9999, start: 'start-9999' },
    ];
    expect(thaw(recorded, deps)).toEqual([4250]);
    expect(deps.signals).toEqual([{ pid: 4250, signal: 'SIGCONT' }]);
  });

  it('a bare pid from an older record gets the ownership check only', () => {
    const deps = fakeFreezeDeps(TREE, { starts: { 4251: 'whatever' }, uids: { 4252: 0 } });
    expect(thaw([4250, 4251, 4252, 9999, 1, 0, -3], deps)).toEqual([4250, 4251]);
  });
});

describe('what a freeze may signal', () => {
  /** The daemon (7000) was started from inside the session it is asked to freeze. */
  const NESTED = [
    { pid: 4242, ppid: 1 },
    { pid: 4250, ppid: 4242 },
    { pid: 6000, ppid: 4250 },
    { pid: 7000, ppid: 6000 },
    { pid: 4251, ppid: 4250 },
  ];

  it('never the daemon itself or anything above it, even inside the session tree', () => {
    const deps = fakeFreezeDeps(NESTED, { selfPid: 7000 });
    expect(ancestorsOf(7000, NESTED)).toEqual([6000, 4250, 4242, 1]);
    expect([...protectedPids(deps, NESTED)].sort((a, b) => a - b)).toEqual([0, 1, 4242, 4250, 6000, 7000]);
    expect(freezeTree(4242, deps)).toEqual([4251]);
    expect(deps.signals).toEqual([{ pid: 4251, signal: 'SIGSTOP' }]);
  });

  it('thaw leaves the daemon and its ancestors alone too', () => {
    const deps = fakeFreezeDeps(NESTED, { selfPid: 7000 });
    expect(thaw([4250, 6000, 7000, 4251], deps)).toEqual([4251]);
  });

  it('survives a parent loop in the process table', () => {
    const loop = [
      { pid: 5, ppid: 6 },
      { pid: 6, ppid: 5 },
    ];
    expect(ancestorsOf(5, loop)).toEqual([6]);
  });

  it('hands the list to `record` before the first SIGSTOP', () => {
    const order: string[] = [];
    const deps = fakeFreezeDeps(TREE);
    const kill = deps.kill;
    deps.kill = (pid, signal) => {
      order.push(`${signal}:${String(pid)}`);
      kill(pid, signal);
    };
    freezeTree(4242, deps, {
      record: (procs) => order.push(`record:${procs.map((p) => `${String(p.pid)}@${String(p.start)}`).join(',')}`),
    });
    expect(order).toEqual(['record:4250@start-4250,4251@start-4251,4252@start-4252', 'SIGSTOP:4252', 'SIGSTOP:4251', 'SIGSTOP:4250']);
  });

  it('sessions.json already names every pid when the first SIGSTOP is sent, so a crash mid-freeze is recoverable', async () => {
    const { h, base } = await serve({ table: TREE });
    await post(base, '/v1/sessions/register', reg());
    h.alive.add(4242);
    const onDisk: number[][] = [];
    // Observe the file from inside the signal call by wrapping the recorded-signals array.
    const push = h.signals.push.bind(h.signals);
    h.signals.push = (...items: RecordedSignal[]) => {
      const file = JSON.parse(readFileSync(sessionsFilePath(h.configDir), 'utf8')) as { sessions: Array<{ frozenPids: number[] }> };
      onDisk.push(file.sessions[0]?.frozenPids ?? []);
      return push(...items);
    };
    expect((await post(base, `/v1/sessions/${S1}/pause`, { mode: 'hard' })).status).toBe(200);
    expect(h.signals.map((s) => s.signal)).toEqual(['SIGSTOP', 'SIGSTOP', 'SIGSTOP']);
    expect(onDisk[0]).toEqual([4250, 4251, 4252]);

    // The daemon "dies" here. `resume --all` needs nothing but the file.
    const offline: RecordedSignal[] = [];
    const result = resumeAll(h.configDir, fakeFreezeDeps(TREE, { signals: offline }));
    expect(result.resumed).toEqual([4250, 4251, 4252]);
    expect(offline.map((s) => s.signal)).toEqual(['SIGCONT', 'SIGCONT', 'SIGCONT']);
  });
});

describe('the registry is bounded', () => {
  it('has a finite default', () => {
    expect(MAX_SESSIONS).toBeGreaterThan(16);
    expect(MAX_SESSIONS).toBeLessThanOrEqual(1024);
  });

  it('evicts dead and pid-less sessions to make room, and refuses when every slot is a live one', async () => {
    const table = [1, 2, 3].map((i) => ({ pid: 5000 + i, ppid: 1 }));
    const { h, base } = await serve({ table, maxSessions: 3 });
    for (const i of [1, 2, 3]) h.alive.add(5000 + i);
    // Two pid-less, one live.
    expect((await post(base, '/v1/sessions/register', { sessionId: uuid(1) })).status).toBe(200);
    h.clock.now += 1_000;
    expect((await post(base, '/v1/sessions/register', { sessionId: uuid(2) })).status).toBe(200);
    expect((await post(base, '/v1/sessions/register', { sessionId: uuid(3), pid: 5001 })).status).toBe(200);
    // Full: the pid-less one that has been quiet longest goes first.
    expect((await post(base, '/v1/sessions/register', { sessionId: uuid(4), pid: 5002 })).status).toBe(200);
    expect(h.subsystem.registry.all().map((s) => s.sessionId).sort()).toEqual([uuid(2), uuid(3), uuid(4)]);
    expect((await post(base, '/v1/sessions/register', { sessionId: uuid(5), pid: 5003 })).status).toBe(200);
    // Now all three are live sessions with trusted pids: nothing may be evicted.
    const full = await post(base, '/v1/sessions/register', { sessionId: uuid(6) });
    expect(full.status).toBe(503);
    expect((full.body['error'] as { code: string }).code).toBe('unavailable');
    expect(h.subsystem.registry.all()).toHaveLength(3);
    // Re-registering one that is already there is not a new slot.
    expect((await post(base, '/v1/sessions/register', { sessionId: uuid(5), pid: 5003 })).status).toBe(200);
  });

  it('reaps a pid-less session that has not heart-beaten for the TTL, and not a moment sooner', async () => {
    const { h, base } = await serve({ table: TREE });
    await post(base, '/v1/sessions/register', { sessionId: S1 });
    await post(base, '/v1/sessions/register', reg({ sessionId: S2 }));
    h.alive.add(4242);
    h.clock.now += PIDLESS_SESSION_TTL_MS - 1_000;
    expect(h.subsystem.registry.checkLiveness().dropped).toEqual([]);
    // A heartbeat is proof of life and restarts the clock.
    expect((await post(base, `/v1/sessions/${S1}/heartbeat`, {})).status).toBe(200);
    h.clock.now += PIDLESS_SESSION_TTL_MS - 1_000;
    expect(h.subsystem.registry.checkLiveness().dropped).toEqual([]);
    h.clock.now += 2_000;
    expect(h.subsystem.registry.checkLiveness().dropped.map((s) => s.sessionId)).toEqual([S1]);
    // The session with a live, trusted pid is untouched however long it idles.
    expect(h.subsystem.registry.get(S2)?.alive).toBe(true);
  });
});

describe('what survives a restart', () => {
  function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: S1,
      pid: 4242,
      pidStart: 'start-4242',
      cwd: '/tmp/x/foo',
      transcriptPath: null,
      gitCommonDir: null,
      source: null,
      registeredAt: '2026-09-13T11:00:00.000Z',
      lastActivityAt: '2026-09-13T11:59:00.000Z',
      alive: true,
      deadSince: null,
      frozenPids: [4250, 4251],
      frozenStarts: ['start-4250', 'start-4251'],
      frozenPid: 4242,
      freezes: 1,
      pausedSince: '2026-09-13T11:30:00.000Z',
      lastTool: null,
      ...over,
    };
  }

  it('records the boot id next to the pids', async () => {
    const { h, base } = await serve({ table: TREE });
    await post(base, '/v1/sessions/register', reg());
    const file = JSON.parse(readFileSync(sessionsFilePath(h.configDir), 'utf8')) as { bootId: string; sessions: Array<{ pidStart: string }> };
    expect(file.bootId).toBe('boot-1');
    expect(file.sessions[0]?.pidStart).toBe('start-4242');
  });

  it('after a reboot: every persisted pid is discarded and nothing at all is signalled', () => {
    const configDir = tempDir();
    writeJsonFile(sessionsFilePath(configDir), { version: 1, rev: 4, bootId: 'boot-0', sessions: [stored()] });
    writeJsonFile(pauseFilePath(configDir), { version: 1, rules: [{ id: 'r1', scope: 'all', mode: 'hard', reason: '', createdBy: 'cli', createdAt: '2026-09-13T11:30:00.000Z' }] });
    const h = makeHarness({ configDir, table: TREE });
    harnesses.push(h);
    h.alive.add(4242);
    h.subsystem.start();
    expect(h.signals).toEqual([]);
    expect(h.subsystem.registry.get(S1)).toMatchObject({ pid: null, pidStart: null, alive: false, frozenPids: [], frozenPid: null });
  });

  it('same boot: the recorded tree is thawed and re-frozen, each pid checked against its start time', () => {
    const configDir = tempDir();
    writeJsonFile(sessionsFilePath(configDir), { version: 1, rev: 4, bootId: 'boot-1', sessions: [stored()] });
    writeJsonFile(pauseFilePath(configDir), { version: 1, rules: [{ id: 'r1', scope: 'all', mode: 'hard', reason: '', createdBy: 'cli', createdAt: '2026-09-13T11:30:00.000Z' }] });
    // 4251 was recycled while the daemon was down.
    const h = makeHarness({ configDir, table: TREE, starts: { 4251: 'recycled' } });
    harnesses.push(h);
    h.alive.add(4242);
    h.subsystem.start();
    expect(h.signals.filter((s) => s.signal === 'SIGCONT')).toEqual([{ pid: 4250, signal: 'SIGCONT' }]);
    expect(h.signals.filter((s) => s.signal === 'SIGSTOP').map((s) => s.pid)).toEqual([4252, 4251, 4250]);
  });

  it('a file from before start times were kept: a Claude Code pid is adopted, anything else is forgotten', () => {
    const configDir = tempDir();
    const legacy = (id: string, pid: number): Record<string, unknown> => {
      const s = stored({ sessionId: id, pid, frozenPids: [], frozenPid: null, pausedSince: null, freezes: 0 });
      delete s['pidStart'];
      delete s['frozenStarts'];
      return s;
    };
    writeJsonFile(sessionsFilePath(configDir), { version: 1, rev: 4, sessions: [legacy(S1, 4242), legacy(S2, 4250), legacy(S3, 31337)] });
    const h = makeHarness({ configDir, table: TREE, commands: { 4250: '/bin/zsh' } });
    harnesses.push(h);
    h.subsystem.start();
    expect(h.subsystem.registry.get(S1)).toMatchObject({ pid: 4242, pidStart: 'start-4242', alive: true });
    expect(h.subsystem.registry.get(S2)).toMatchObject({ pid: null, alive: false });
    expect(h.subsystem.registry.get(S3)).toMatchObject({ pid: null, alive: false });
    expect(h.signals).toEqual([]);
  });

  it('resume --all with no daemon: forgets pids from another boot without signalling them', () => {
    const configDir = tempDir();
    writeJsonFile(sessionsFilePath(configDir), { version: 1, rev: 4, bootId: 'boot-0', sessions: [stored()] });
    const signals: RecordedSignal[] = [];
    const result = resumeAll(configDir, fakeFreezeDeps(TREE, { signals }));
    expect(result.resumed).toEqual([]);
    expect(signals).toEqual([]);
    const after = JSON.parse(readFileSync(sessionsFilePath(configDir), 'utf8')) as { sessions: Array<{ frozenPids: number[] }> };
    expect(after.sessions[0]?.frozenPids).toEqual([]);
  });
});

describe('real process identity on this machine', () => {
  it('reports this process with a stable start time and the right uid', () => {
    const a = inspectProcesses([process.pid, 2 ** 30]).get(process.pid);
    const b = inspectProcesses([process.pid]).get(process.pid);
    expect(a).toBeDefined();
    expect(a?.start.length).toBeGreaterThan(0);
    expect(a?.start).toBe(b?.start);
    expect(a?.uid).toBe(typeof process.getuid === 'function' ? process.getuid() : a?.uid);
    expect(a?.command.length).toBeGreaterThan(0);
    expect(inspectProcesses([2 ** 30]).size).toBe(0);
    expect(inspectProcesses([]).size).toBe(0);
  });

  it('has a boot id that does not change between two reads', () => {
    const id = readBootId();
    expect(id).not.toBeNull();
    expect(readBootId()).toBe(id);
  });

  it('parses `ps -o pid=,uid=,lstart=,command=` whatever the day-of-month padding', () => {
    const text = ['  812   501 Tue Oct 13 22:09:10 2026 claude --resume', '12345     0 Fri Oct  9 08:20:04 2026 /sbin/launchd', 'garbage'].join('\n');
    const parsed = parsePsIdentities(text);
    expect(parsed.get(812)).toEqual({ pid: 812, uid: 501, start: 'Tue Oct 13 22:09:10 2026', command: 'claude --resume' });
    expect(parsed.get(12345)).toEqual({ pid: 12345, uid: 0, start: 'Fri Oct 9 08:20:04 2026', command: '/sbin/launchd' });
    expect(parsed.size).toBe(2);
  });
});

describe('the crash path', () => {
  function frozenOnDisk(configDir: string): void {
    writeJsonFile(sessionsFilePath(configDir), {
      version: 1,
      rev: 2,
      bootId: 'boot-1',
      sessions: [{ sessionId: S1, pid: 4242, pidStart: 'start-4242', frozenPids: [4250, 4251], frozenStarts: ['start-4250', 'start-4251'], frozenPid: 4242, freezes: 1, pausedSince: 'x', alive: true }],
    });
    writeJsonFile(pauseFilePath(configDir), { version: 1, rules: [{ id: 'r1', scope: 'all', mode: 'hard' }] });
    writeJsonFile(daemonFilePath(configDir), { pid: 1, port: 1 });
  }

  it('SIGCONTs everything recorded, leaves the rules, removes daemon.json and exits 1 — once', () => {
    const configDir = tempDir();
    frozenOnDisk(configDir);
    const signals: RecordedSignal[] = [];
    const exits: number[] = [];
    const lines: string[] = [];
    const onCrash = crashHandler({
      configDir,
      thawLive: () => undefined,
      log: (l) => lines.push(l),
      exit: (c) => exits.push(c),
      freezeDeps: fakeFreezeDeps(TREE, { signals }),
    });
    onCrash(new Error('boom'));
    onCrash(new Error('again'));
    expect(signals).toEqual([
      { pid: 4250, signal: 'SIGCONT' },
      { pid: 4251, signal: 'SIGCONT' },
    ]);
    expect(exits).toEqual([1]);
    expect(lines.join('\n')).toContain('boom');
    expect(existsSync(daemonFilePath(configDir))).toBe(false);
    const sessions = JSON.parse(readFileSync(sessionsFilePath(configDir), 'utf8')) as { sessions: Array<{ frozenPids: number[] }> };
    expect(sessions.sessions[0]?.frozenPids).toEqual([]);
    const rules = JSON.parse(readFileSync(pauseFilePath(configDir), 'utf8')) as { rules: unknown[] };
    expect(rules.rules).toHaveLength(1);
  });

  it('still thaws from disk and exits when the in-memory thaw and the logger both throw', () => {
    const configDir = tempDir();
    frozenOnDisk(configDir);
    const signals: RecordedSignal[] = [];
    const exits: number[] = [];
    crashHandler({
      configDir,
      thawLive: () => {
        throw new Error('registry is gone');
      },
      log: () => {
        throw new Error('stderr is closed');
      },
      exit: (c) => exits.push(c),
      freezeDeps: fakeFreezeDeps(TREE, { signals }),
    })('a rejected promise');
    expect(signals.map((s) => s.pid)).toEqual([4250, 4251]);
    expect(exits).toEqual([1]);
  });

  it('thawRecorded tolerates a missing or corrupt file', () => {
    const configDir = tempDir();
    expect(thawRecorded(configDir, fakeFreezeDeps(TREE))).toEqual([]);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(sessionsFilePath(configDir), '{ not json');
    expect(thawRecorded(configDir, fakeFreezeDeps(TREE))).toEqual([]);
  });

  it('a daemon that fails to come up after the startup sweep froze something thaws it again', async () => {
    const configDir = tempDir();
    writeJsonFile(sessionsFilePath(configDir), {
      version: 1,
      rev: 2,
      bootId: 'boot-1',
      sessions: [{ sessionId: S1, pid: 4242, pidStart: 'start-4242', cwd: '/tmp', frozenPids: [], frozenPid: null, freezes: 0, alive: true }],
    });
    writeJsonFile(pauseFilePath(configDir), { version: 1, rules: [{ id: 'r1', scope: 'all', mode: 'hard', reason: '', createdBy: 'cli', createdAt: '2026-09-13T11:30:00.000Z' }] });
    // Something else already holds the port.
    const blocker = await startDaemon({ configDir: tempDir(), config: testConfig({ port: 0 }), tokens: null, poll: false, port: 0, sessions: false, log: () => undefined, updater: null });
    const signals: RecordedSignal[] = [];
    try {
      await expect(
        startDaemon({
          configDir,
          config: testConfig(),
          tokens: null,
          poll: false,
          port: blocker.port,
          log: () => undefined,
          updater: null,
          freezeDeps: fakeFreezeDeps(TREE, { signals }),
        }),
      ).rejects.toBeInstanceOf(PortInUseError);
    } finally {
      await blocker.stop();
    }
    expect(signals.filter((s) => s.signal === 'SIGSTOP').map((s) => s.pid)).toEqual([4252, 4251, 4250]);
    expect(signals.filter((s) => s.signal === 'SIGCONT').map((s) => s.pid)).toEqual([4250, 4251, 4252]);
  });
});
