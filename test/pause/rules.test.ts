import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  newRuleId,
  normalizeReason,
  parseScope,
  pauseFilePath,
  PauseRuleStore,
  pickEffective,
  REASON_MAX_CHARS,
  ruleMatches,
  type PauseRule,
} from '../../src/pause/rules.js';
import { makeHarness, tempDir } from '../sessions/helpers.js';

const GIT_COMMON = '/tmp/x/foo/.git';
const MAIN = '/tmp/x/foo';
const WORKTREE = '/tmp/x/foo-wt2';

function rule(over: Partial<PauseRule> = {}): PauseRule {
  return {
    id: over.id ?? 'r_test',
    scope: over.scope ?? 'all',
    mode: over.mode ?? 'soft',
    reason: over.reason ?? '',
    createdAt: over.createdAt ?? '2026-09-13T12:00:00.000Z',
    createdBy: over.createdBy ?? 'cli',
  };
}

describe('scope parsing', () => {
  it('accepts the three spec forms and nothing else', () => {
    expect(parseScope('all')).toEqual({ kind: 'all' });
    expect(parseScope('project:/tmp/x/foo')).toEqual({ kind: 'project', value: MAIN });
    expect(parseScope('session:abc')).toEqual({ kind: 'session', value: 'abc' });
    expect(parseScope('project:')).toBeNull();
    expect(parseScope('nonsense')).toBeNull();
    expect(parseScope(42)).toBeNull();
  });

  it('mints ids with the r_ prefix', () => {
    const id = newRuleId();
    expect(id.startsWith('r_')).toBe(true);
    expect(id).toMatch(/^r_[a-z2-7]{16}$/);
    expect(newRuleId()).not.toBe(id);
  });
});

describe('reason handling (§23.13)', () => {
  it('echoes the reason verbatim', () => {
    expect(normalizeReason('usage-deck:abc123')).toBe('usage-deck:abc123');
    expect(normalizeReason(undefined)).toBe('');
  });

  it('trims to 200 characters', () => {
    const long = 'x'.repeat(500);
    expect(normalizeReason(long)).toHaveLength(REASON_MAX_CHARS);
  });
});

describe('rule matching', () => {
  const target = { sessionId: 'sess-1', gitCommonDir: GIT_COMMON, cwd: WORKTREE };

  it('matches a project rule spelled as the git common dir or the main worktree', () => {
    expect(ruleMatches(rule({ scope: `project:${GIT_COMMON}` }), target)).toBe(true);
    expect(ruleMatches(rule({ scope: `project:${MAIN}` }), target)).toBe(true);
    expect(ruleMatches(rule({ scope: `project:${WORKTREE}` }), target)).toBe(true);
    expect(ruleMatches(rule({ scope: 'project:/tmp/other' }), target)).toBe(false);
  });

  it('matches a repo-less session by cwd', () => {
    const loose = { sessionId: 's', gitCommonDir: null, cwd: '/tmp/scratch' };
    expect(ruleMatches(rule({ scope: 'project:/tmp/scratch' }), loose)).toBe(true);
    expect(ruleMatches(rule({ scope: `project:${MAIN}` }), loose)).toBe(false);
  });

  it('matches all and session scopes', () => {
    expect(ruleMatches(rule({ scope: 'all' }), target)).toBe(true);
    expect(ruleMatches(rule({ scope: 'session:sess-1' }), target)).toBe(true);
    expect(ruleMatches(rule({ scope: 'session:other' }), target)).toBe(false);
  });
});

describe('effective rule (§18.1)', () => {
  const target = { sessionId: 'sess-1', gitCommonDir: GIT_COMMON, cwd: MAIN };

  it('prefers session over project over all', () => {
    const all = rule({ id: 'r_all', scope: 'all' });
    const project = rule({ id: 'r_proj', scope: `project:${MAIN}` });
    const session = rule({ id: 'r_sess', scope: 'session:sess-1' });
    expect(pickEffective([all], target)?.id).toBe('r_all');
    expect(pickEffective([all, project], target)?.id).toBe('r_proj');
    expect(pickEffective([all, project, session], target)?.id).toBe('r_sess');
  });

  it('lets hard beat soft at equal specificity', () => {
    const soft = rule({ id: 'r_soft', scope: 'all', mode: 'soft' });
    const hard = rule({ id: 'r_hard', scope: 'all', mode: 'hard' });
    expect(pickEffective([soft, hard], target)?.id).toBe('r_hard');
    expect(pickEffective([hard, soft], target)?.id).toBe('r_hard');
  });

  it('does not let a broader hard rule beat a narrower soft rule', () => {
    const hardAll = rule({ id: 'r_hard', scope: 'all', mode: 'hard' });
    const softSession = rule({ id: 'r_soft', scope: 'session:sess-1', mode: 'soft' });
    expect(pickEffective([hardAll, softSession], target)?.id).toBe('r_soft');
  });

  it('returns null when nothing matches', () => {
    expect(pickEffective([rule({ scope: 'session:other' })], target)).toBeNull();
  });
});

describe('PauseRuleStore', () => {
  it('is idempotent on (scope, mode) and persists at 0600', () => {
    const configDir = tempDir('cu-rules-');
    const store = new PauseRuleStore({ configDir });
    const first = store.add({ scope: 'all', mode: 'soft', reason: 'deploy window', createdBy: 'cli' });
    const second = store.add({ scope: 'all', mode: 'soft', reason: 'something else', createdBy: 'dashboard' });
    expect(second.created).toBe(false);
    expect(second.rule.id).toBe(first.rule.id);
    expect(second.rule.reason).toBe('deploy window');
    expect(store.list()).toHaveLength(1);

    // A different mode for the same scope SUPERSEDES rather than stacking, so a client that
    // escalates soft -> hard never leaves the loser behind for someone else to delete.
    const escalated = store.add({ scope: 'all', mode: 'hard', createdBy: 'cli' });
    expect(escalated.created).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.mode).toBe('hard');

    const file = pauseFilePath(configDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = new PauseRuleStore({ configDir });
    reloaded.load();
    expect(reloaded.list().map((r) => r.id).sort()).toEqual(store.list().map((r) => r.id).sort());
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('removes by id, and resuming `all` lifts every rule under it', () => {
    const store = new PauseRuleStore({ configDir: tempDir('cu-rules-') });
    const a = store.add({ scope: 'session:y', mode: 'soft', createdBy: 'cli' }).rule;
    expect(store.remove(a.id)?.id).toBe(a.id);
    expect(store.remove('r_nope')).toBeNull();

    store.add({ scope: 'all', mode: 'hard', createdBy: 'cli' });
    store.add({ scope: 'session:x', mode: 'soft', createdBy: 'cli' });
    // "Resume everything" must not leave a narrower rule holding a session down.
    expect(store.removeByScope('all')).toHaveLength(2);
    expect(store.list()).toEqual([]);
  });

  it("resuming a project lifts the session rules inside it, via the caller's membership test", () => {
    const store = new PauseRuleStore({ configDir: tempDir('cu-rules-') });
    store.add({ scope: 'project:/repo/.git', mode: 'soft', createdBy: 'dashboard' });
    store.add({ scope: 'session:inside', mode: 'hard', createdBy: 'dashboard' });
    store.add({ scope: 'session:elsewhere', mode: 'soft', createdBy: 'dashboard' });
    const removed = store.removeByScope('project:/repo/.git', (r) => r.scope === 'session:inside');
    expect(removed.map((r) => r.scope).sort()).toEqual(['project:/repo/.git', 'session:inside']);
    expect(store.list().map((r) => r.scope)).toEqual(['session:elsewhere']);
  });
});

describe('resume is idempotent (contract the dashboard relies on)', () => {
  it('a no-op resume never errors: empty arrays for unknown session, project and all', () => {
    const h = makeHarness();
    for (const scope of ['session:does-not-exist', 'project:/nope/.git', 'all']) {
      expect(h.subsystem.pause.resume(scope)).toEqual({ removed: [], resumed: [] });
    }
  });

  it('resuming the same scope twice is a no-op the second time', () => {
    const h = makeHarness();
    h.subsystem.registry.register({ sessionId: 'sess-1', pid: process.pid, cwd: '/tmp/x/foo' });
    h.subsystem.pause.pause({ scope: 'session:sess-1', mode: 'soft', createdBy: 'dashboard' });
    expect(h.subsystem.pause.resume('session:sess-1').removed).toHaveLength(1);
    expect(h.subsystem.pause.resume('session:sess-1')).toEqual({ removed: [], resumed: [] });
  });
});

describe('rules apply to sessions that register later (§18.1)', () => {
  it('a new worktree session in a paused project comes up paused', () => {
    const h = makeHarness();
    h.subsystem.pause.pause({ scope: `project:${MAIN}`, mode: 'soft', reason: 'release', createdBy: 'dashboard' });

    h.subsystem.registry.register({ sessionId: 'late', pid: 9, cwd: WORKTREE, gitCommonDir: GIT_COMMON });
    const view = h.subsystem.registry.viewOf('late');
    expect(view?.pause).toMatchObject({ mode: 'soft', scope: `project:${MAIN}` });
    expect(h.subsystem.pause.gate('late')).toMatchObject({ paused: true, mode: 'soft', reason: 'release' });
  });

  it('an unknown session still inherits the "all" rule', () => {
    const h = makeHarness();
    h.subsystem.pause.pause({ scope: 'all', mode: 'soft', createdBy: 'dashboard' });
    expect(h.subsystem.pause.gate('never-registered').paused).toBe(true);
  });
});
