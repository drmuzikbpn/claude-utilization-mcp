import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEAD_RETENTION_MS, resolveProject, SessionRegistry, sessionsFilePath } from '../../src/sessions/registry.js';
import { makeHarness, StubTokens, tempDir } from './helpers.js';

const MAIN = '/tmp/x/foo';
const GIT_COMMON = '/tmp/x/foo/.git';
const WORKTREE = '/tmp/x/foo-wt2';

function register(h: ReturnType<typeof makeHarness>, over: Record<string, unknown> = {}): void {
  h.subsystem.registry.register({
    sessionId: 'sess-1',
    pid: 4242,
    cwd: MAIN,
    transcriptPath: '/tmp/t/sess-1.jsonl',
    gitCommonDir: GIT_COMMON,
    source: 'startup',
    ...over,
  });
}

describe('resolveProject (§17.3)', () => {
  it('names the project after the main worktree and leaves worktree null there', () => {
    expect(resolveProject(MAIN, GIT_COMMON)).toEqual({
      project: { gitCommonDir: GIT_COMMON, name: 'foo' },
      worktree: null,
    });
  });

  it('groups a linked worktree under the same project', () => {
    expect(resolveProject(WORKTREE, GIT_COMMON)).toEqual({
      project: { gitCommonDir: GIT_COMMON, name: 'foo' },
      worktree: 'foo-wt2',
    });
  });

  it('falls back to basename(cwd) outside a repository', () => {
    expect(resolveProject('/tmp/scratch/notes', null)).toEqual({
      project: { gitCommonDir: null, name: 'notes' },
      worktree: null,
    });
  });

  it('tolerates a trailing slash on either path', () => {
    expect(resolveProject('/tmp/x/foo/', '/tmp/x/foo/.git/')).toEqual({
      project: { gitCommonDir: GIT_COMMON, name: 'foo' },
      worktree: null,
    });
  });
});

describe('SessionRegistry lifecycle (§17.1)', () => {
  it('registers, heartbeats and ends a session, bumping rev each time', () => {
    const h = makeHarness();
    const revs: number[] = [];
    register(h);
    revs.push(h.subsystem.registry.rev);

    h.clock.now += 60_000;
    h.subsystem.registry.heartbeat('sess-1');
    revs.push(h.subsystem.registry.rev);

    const view = h.subsystem.registry.viewOf('sess-1');
    expect(view?.lastActivityAt).toBe('2026-09-13T12:01:00.000Z');
    expect(view?.pid).toBe(4242);
    expect(view?.discovered).toBe('hook');
    expect(view?.alive).toBe(true);

    expect(h.subsystem.registry.end('sess-1')).not.toBeNull();
    revs.push(h.subsystem.registry.rev);
    expect(h.subsystem.registry.get('sess-1')).toBeNull();
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(3);
  });

  it('is idempotent: re-registering keeps the id and takes the new pid', () => {
    const h = makeHarness();
    register(h);
    const first = h.subsystem.registry.get('sess-1');
    h.clock.now += 5_000;
    register(h, { pid: 5555, source: 'resume' });
    const second = h.subsystem.registry.get('sess-1');
    expect(h.subsystem.registry.all()).toHaveLength(1);
    expect(second?.pid).toBe(5555);
    expect(second?.registeredAt).toBe(first?.registeredAt);
    expect(second?.source).toBe('resume');
  });

  it('publishes start/update/end on the bus', () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.bus.subscribe('session', (payload) => seen.push(payload.type));
    register(h);
    register(h);
    h.subsystem.registry.heartbeat('sess-1');
    h.subsystem.registry.end('sess-1');
    expect(seen).toEqual(['start', 'update', 'update', 'end']);
  });

  it('records lastTool from the gate (§23.13)', () => {
    const h = makeHarness();
    register(h);
    expect(h.subsystem.registry.viewOf('sess-1')?.lastTool).toBeNull();
    h.clock.now += 1_000;
    h.subsystem.pause.gate('sess-1', 'Bash');
    expect(h.subsystem.registry.viewOf('sess-1')?.lastTool).toEqual({
      name: 'Bash',
      at: '2026-09-13T12:00:01.000Z',
    });
  });

  it('never records lastTool for an unknown session', () => {
    const h = makeHarness();
    expect(h.subsystem.pause.gate('ghost', 'Read')).toEqual({
      paused: false,
      mode: null,
      ruleId: null,
      reason: null,
    });
  });
});

describe('liveness (§17.2)', () => {
  it('marks a dead pid and drops it after five minutes', () => {
    const h = makeHarness();
    h.alive.add(4242);
    register(h);
    expect(h.subsystem.registry.checkLiveness()).toEqual({ died: [], dropped: [] });
    expect(h.subsystem.registry.viewOf('sess-1')?.alive).toBe(true);

    h.alive.delete(4242);
    const died = h.subsystem.registry.checkLiveness();
    expect(died.died.map((s) => s.sessionId)).toEqual(['sess-1']);
    expect(h.subsystem.registry.viewOf('sess-1')?.alive).toBe(false);

    h.clock.now += DEAD_RETENTION_MS - 1_000;
    expect(h.subsystem.registry.checkLiveness().dropped).toHaveLength(0);
    expect(h.subsystem.registry.get('sess-1')).not.toBeNull();

    h.clock.now += 2_000;
    expect(h.subsystem.registry.checkLiveness().dropped.map((s) => s.sessionId)).toEqual(['sess-1']);
    expect(h.subsystem.registry.get('sess-1')).toBeNull();
  });

  it('revives a session whose pid comes back (resume re-uses the id)', () => {
    const h = makeHarness();
    register(h);
    h.subsystem.registry.checkLiveness();
    expect(h.subsystem.registry.viewOf('sess-1')?.alive).toBe(false);
    h.alive.add(4242);
    h.subsystem.registry.checkLiveness();
    expect(h.subsystem.registry.viewOf('sess-1')?.alive).toBe(true);
  });
});

describe('transcript back-fill (§17.2)', () => {
  it('shows transcript-only sessions with pid null and discovered "transcript"', () => {
    const h = makeHarness();
    h.tokens.add('from-transcript', { cwd: '/tmp/x/bar', projectKey: '-tmp-x-bar' });
    const list = h.subsystem.registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sessionId: 'from-transcript',
      pid: null,
      alive: false,
      discovered: 'transcript',
      project: { gitCommonDir: null, name: 'bar' },
      worktree: null,
      model: 'claude-fable-5-1',
    });
    expect(list[0]?.tokens.messages).toBe(2);
  });

  it('a transcript written in the last 10 minutes reads alive; older than 24 h is omitted', () => {
    const h = makeHarness();
    h.tokens.add('fresh', { lastActivityAt: '2026-09-13T11:58:00.000Z' });
    h.tokens.add('stale', { lastActivityAt: '2026-09-11T12:00:00.000Z' });
    h.tokens.add('hour-old', { lastActivityAt: '2026-09-13T11:00:00.000Z' });
    const byId = new Map(h.subsystem.registry.list().map((v) => [v.sessionId, v]));
    expect(byId.get('fresh')).toMatchObject({ alive: true, discovered: 'transcript', pid: null });
    expect(byId.get('hour-old')).toMatchObject({ alive: false, discovered: 'transcript' });
    expect(byId.has('stale')).toBe(false);
  });

  it('a registered session wins over its transcript entry', () => {
    const h = makeHarness();
    h.tokens.add('sess-1', { cwd: MAIN });
    register(h);
    const list = h.subsystem.registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.discovered).toBe('hook');
    // model/tokens/startedAt still come from the spend store (§17.2).
    expect(list[0]?.model).toBe('claude-fable-5-1');
    expect(list[0]?.startedAt).toBe('2026-09-13T10:00:00.000Z');
    expect(list[0]?.tokens.input).toBe(10);
  });

  it('tolerates a TokensSource without listSessions', () => {
    const configDir = tempDir();
    const tokens = new StubTokens();
    const registry = new SessionRegistry({ configDir, tokens: { ...tokens, listSessions: undefined } as never });
    expect(registry.list()).toEqual([]);
  });
});

describe('worktree grouping (§17.3, §22)', () => {
  it('groups two worktrees of one repo under one project', () => {
    const h = makeHarness();
    register(h, { sessionId: 'wt-main', pid: 1, cwd: MAIN });
    register(h, { sessionId: 'wt-two', pid: 2, cwd: WORKTREE });
    const byId = new Map(h.subsystem.registry.list().map((s) => [s.sessionId, s]));
    expect(byId.get('wt-main')?.project).toEqual({ gitCommonDir: GIT_COMMON, name: 'foo' });
    expect(byId.get('wt-two')?.project).toEqual({ gitCommonDir: GIT_COMMON, name: 'foo' });
    expect(byId.get('wt-main')?.worktree).toBeNull();
    expect(byId.get('wt-two')?.worktree).toBe('foo-wt2');
  });
});

describe('persistence', () => {
  it('writes sessions.json at 0600 and reloads it', () => {
    const h = makeHarness();
    register(h);
    const file = sessionsFilePath(h.configDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sessions: unknown[]; rev: number };
    expect(parsed.sessions).toHaveLength(1);

    const reloaded = new SessionRegistry({ configDir: h.configDir });
    reloaded.load();
    expect(reloaded.get('sess-1')?.pid).toBe(4242);
    expect(reloaded.rev).toBe(parsed.rev);
  });

  it('never touches the spend store’s state.json', () => {
    const h = makeHarness();
    register(h);
    expect(() => statSync(`${h.configDir}/state.json`)).toThrow();
  });
});

describe('titles (§23.14)', () => {
  it('reads the /rename title from the token store for hook and transcript sessions', () => {
    const h = makeHarness();
    h.tokens.add('from-transcript', { cwd: '/tmp/x/bar', projectKey: '-tmp-x-bar' });
    h.tokens.titles.set('from-transcript', 'Jamie - Android OS');
    h.subsystem.registry.register({ sessionId: 'sess-1', pid: process.pid, cwd: '/tmp/t' });
    h.tokens.titles.set('sess-1', 'Ethan - Launch Daemon');
    const byId = new Map(h.subsystem.registry.list().map((v) => [v.sessionId, v]));
    expect(byId.get('from-transcript')?.title).toBe('Jamie - Android OS');
    expect(byId.get('sess-1')?.title).toBe('Ethan - Launch Daemon');
  });

  it('falls back to the custom-title.json sidecar next to the transcript, and is null when never renamed', () => {
    const h = makeHarness();
    const dir = mkdtempSync(join(tmpdir(), 'cu-title-'));
    const transcriptPath = join(dir, 'sess-2.jsonl');
    writeFileSync(transcriptPath, '');
    mkdirSync(join(dir, 'sess-2'), { recursive: true });
    writeFileSync(join(dir, 'sess-2', 'custom-title.json'), JSON.stringify({ customTitle: '  Sidecar Title  ' }));
    h.subsystem.registry.register({ sessionId: 'sess-2', pid: process.pid, cwd: dir, transcriptPath });
    h.subsystem.registry.register({ sessionId: 'sess-3', pid: process.pid, cwd: dir });
    const byId = new Map(h.subsystem.registry.list().map((v) => [v.sessionId, v]));
    expect(byId.get('sess-2')?.title).toBe('Sidecar Title');
    expect(byId.get('sess-3')?.title).toBeNull();
  });

  it('publishes a session update when a registered session is renamed', () => {
    const h = makeHarness();
    h.subsystem.registry.register({ sessionId: 'sess-4', pid: process.pid, cwd: '/tmp/t' });
    h.subsystem.registry.refreshTitles();
    const seen: Array<{ type: string; session: { sessionId: string; title: string | null } }> = [];
    h.bus.subscribe('session', (payload) => seen.push(payload as (typeof seen)[number]));
    h.tokens.titles.set('sess-4', 'Renamed');
    h.subsystem.registry.refreshTitles();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('update');
    expect(seen[0]?.session.title).toBe('Renamed');
    h.subsystem.registry.refreshTitles();
    expect(seen).toHaveLength(1);
  });
});
