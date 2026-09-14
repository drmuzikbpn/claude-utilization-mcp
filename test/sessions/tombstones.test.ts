/**
 * §23.24: a session we watched stop must not come back to life.
 *
 * Reported from the phone: a session killed at 08:33 still read "1 live" at 08:40. The
 * mechanism is a gap between two timers — a dead session is dropped after
 * `DEAD_RETENTION_MS` (5 min), and the transcript back-fill then finds a transcript written
 * five minutes ago and calls it alive, because its own window is ten.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEAD_RETENTION_MS, SessionRegistry, TRANSCRIPT_ALIVE_MS } from '../../src/sessions/registry.js';
import { FakeTokensSource } from '../helpers/fakes.js';

const temp = (): string => mkdtempSync(join(tmpdir(), 'cu-tomb-'));

/** A token store that reports one transcript-only session, last written `ageMs` ago. */
function tokensAt(sessionId: string, now: () => number, ageMs: () => number): FakeTokensSource {
  const t = new FakeTokensSource();
  (t as unknown as { listSessions: () => unknown[] }).listSessions = () => [
    {
      sessionId,
      cwd: '/tmp/qa',
      projectKey: 'qa',
      lastActivityAt: new Date(now() - ageMs()).toISOString(),
    },
  ];
  return t;
}

describe('session tombstones (§23.24)', () => {
  it('a killed session does not reappear as live once it is dropped', () => {
    let clock = Date.parse('2026-09-14T08:30:00.000Z');
    const now = (): number => clock;
    const dir = temp();
    const registry = new SessionRegistry({ configDir: dir, now });
    // The transcript keeps looking recent: written when the session was killed.
    let killedAt = clock;
    registry.setTokensSource(tokensAt('s1', now, () => clock - killedAt));

    registry.register({ sessionId: 's1', pid: 999_999, cwd: '/tmp/qa' });
    killedAt = clock;

    // The pid is gone: dead, then dropped five minutes later.
    registry.checkLiveness();
    clock += DEAD_RETENTION_MS + 1_000;
    const { dropped } = registry.checkLiveness();
    expect(dropped.map((s) => s.sessionId)).toEqual(['s1']);

    // The back-fill now sees a transcript six minutes old — inside its ten-minute window.
    const view = registry.list().find((v) => v.sessionId === 's1');
    expect(view?.discovered).toBe('transcript');
    expect(view?.alive).toBe(false);
  });

  it('SessionEnd buries it too, so an ended session is not resurrected', () => {
    let clock = Date.parse('2026-09-14T08:30:00.000Z');
    const registry = new SessionRegistry({ configDir: temp(), now: () => clock });
    registry.setTokensSource(tokensAt('s1', () => clock, () => 1_000));
    registry.register({ sessionId: 's1', pid: process.pid, cwd: '/tmp/qa' });
    registry.end('s1');
    clock += 1_000;
    expect(registry.list().find((v) => v.sessionId === 's1')?.alive).toBe(false);
  });

  it('the tombstone survives a daemon restart inside the window', () => {
    let clock = Date.parse('2026-09-14T08:30:00.000Z');
    const dir = temp();
    const first = new SessionRegistry({ configDir: dir, now: () => clock });
    first.register({ sessionId: 's1', pid: process.pid, cwd: '/tmp/qa' });
    first.end('s1');

    clock += 60_000;
    const restarted = new SessionRegistry({ configDir: dir, now: () => clock });
    restarted.load();
    restarted.setTokensSource(tokensAt('s1', () => clock, () => 1_000));
    expect(restarted.list().find((v) => v.sessionId === 's1')?.alive).toBe(false);
  });

  it('expires, so a long-dead id never suppresses a genuinely new session', () => {
    let clock = Date.parse('2026-09-14T08:30:00.000Z');
    const registry = new SessionRegistry({ configDir: temp(), now: () => clock });
    registry.register({ sessionId: 's1', pid: process.pid, cwd: '/tmp/qa' });
    registry.end('s1');
    clock += TRANSCRIPT_ALIVE_MS + 1_000;
    registry.setTokensSource(tokensAt('s1', () => clock, () => 1_000));
    expect(registry.list().find((v) => v.sessionId === 's1')?.alive).toBe(true);
  });

  it('re-registering lifts the tombstone immediately — the session is demonstrably back', () => {
    let clock = Date.parse('2026-09-14T08:30:00.000Z');
    const registry = new SessionRegistry({ configDir: temp(), now: () => clock });
    registry.register({ sessionId: 's1', pid: process.pid, cwd: '/tmp/qa' });
    registry.end('s1');
    clock += 1_000;
    const back = registry.register({ sessionId: 's1', pid: process.pid, cwd: '/tmp/qa' });
    expect(back.alive).toBe(true);
    expect(registry.list().find((v) => v.sessionId === 's1')?.alive).toBe(true);
  });
});
