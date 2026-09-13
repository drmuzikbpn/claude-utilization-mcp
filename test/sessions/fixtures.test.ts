/**
 * The JSON the Android client codes against. These fixtures are a contract: the tests below
 * compare their key sets against what the live server actually emits, so the two cannot
 * drift silently.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../helpers/fixtures.js';
import { makeHarness } from './helpers.js';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'sessions', name), 'utf8')) as Record<string, unknown>;
}

function keys(v: unknown): string[] {
  return Object.keys(v as Record<string, unknown>).sort();
}

function liveSession(): Record<string, unknown> {
  const h = makeHarness();
  h.subsystem.registry.register({
    sessionId: 'sess-1',
    pid: 4242,
    cwd: '/tmp/x/foo-wt2',
    transcriptPath: '/tmp/t/sess-1.jsonl',
    gitCommonDir: '/tmp/x/foo/.git',
    source: 'startup',
  });
  h.subsystem.pause.gate('sess-1', 'Bash');
  h.subsystem.pause.pause({ scope: 'all', mode: 'soft', reason: 'fixture', createdBy: 'dashboard' });
  return h.subsystem.registry.list()[0] as unknown as Record<string, unknown>;
}

describe('sessions.json', () => {
  const body = fixture('sessions.json');

  it('has the §17.3 envelope', () => {
    expect(keys(body)).toEqual(['rev', 'sessions']);
    expect(typeof body['rev']).toBe('number');
  });

  it('every session matches the live session shape', () => {
    const live = liveSession();
    for (const session of body['sessions'] as Record<string, unknown>[]) {
      expect(keys(session)).toEqual(keys(live));
      expect(keys(session['project'])).toEqual(keys(live['project']));
      expect(keys(session['tokens'])).toEqual(keys(live['tokens']));
    }
    const paused = (body['sessions'] as Record<string, unknown>[])[0];
    expect(keys(paused?.['pause'])).toEqual(keys(live['pause']));
    expect(keys(paused?.['lastTool'])).toEqual(keys(live['lastTool']));
  });

  it('covers a worktree, a main checkout and a transcript-only session', () => {
    const sessions = body['sessions'] as Record<string, unknown>[];
    expect(sessions.map((s) => s['discovered'])).toEqual(['hook', 'hook', 'transcript']);
    expect(sessions[0]?.['worktree']).toBe('foo-wt2');
    expect(sessions[1]?.['worktree']).toBeNull();
    expect(sessions[2]?.['pid']).toBeNull();
  });
});

describe('pause fixtures', () => {
  it('pause-rules.json matches the live rule shape', () => {
    const h = makeHarness();
    const live = h.subsystem.pause.pause({ scope: 'all', mode: 'soft', reason: 'x', createdBy: 'cli' });
    expect(live.ok).toBe(true);
    const body = fixture('pause-rules.json');
    expect(keys(body)).toEqual(['rev', 'rules']);
    for (const rule of body['rules'] as Record<string, unknown>[]) {
      expect(keys(rule)).toEqual(live.ok ? keys(live.rule) : []);
      expect(['soft', 'hard']).toContain(rule['mode']);
      expect(['cli', 'dashboard']).toContain(rule['createdBy']);
      expect(String(rule['reason']).length).toBeLessThanOrEqual(200);
    }
    expect((body['rules'] as Record<string, unknown>[]).map((r) => String(r['scope']).split(':')[0])).toEqual([
      'session',
      'project',
      'all',
    ]);
  });

  it('pause-response.json and resume-response.json match §18.4', () => {
    expect(keys(fixture('pause-response.json'))).toEqual(['affected', 'rule']);
    expect(keys(fixture('resume-response.json'))).toEqual(['removed', 'resumed']);
  });
});

describe('errors.json', () => {
  it('always carries a non-empty message and a hint (§23.13)', () => {
    const body = fixture('errors.json');
    expect(Object.keys(body).length).toBeGreaterThanOrEqual(5);
    for (const [name, entry] of Object.entries(body)) {
      const rec = entry as { status: number; body: { error: { code?: string; message?: string; hint?: string } } };
      expect(typeof rec.status, name).toBe('number');
      expect((rec.body.error.code ?? '').length, name).toBeGreaterThan(0);
      expect((rec.body.error.message ?? '').length, name).toBeGreaterThan(0);
      expect((rec.body.error.hint ?? '').length, name).toBeGreaterThan(0);
    }
    expect((body['untrusted_pid'] as { status: number }).status).toBe(409);
    expect((body['dead_session'] as { status: number }).status).toBe(410);
    expect((body['unknown_rule'] as { status: number }).status).toBe(404);
  });
});
