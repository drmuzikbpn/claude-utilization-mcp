/**
 * §23.19: the last good limits snapshot survives a restart.
 *
 * Found in QA from the dashboard side: after an auto-update restart `/v1/summary` served
 * `limits: []` with `fetchedAt: null`, and the first poll came back HTTP 429, so the phone
 * had nothing to show. The numbers were known one second earlier — they just lived only in
 * the memory of a process that had exited.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimitsPoller, limitsCachePath, readCachedSnapshot } from '../src/limits/poller.js';
import { LimitsError } from '../src/limits/types.js';

const temp = (): string => mkdtempSync(join(tmpdir(), 'cu-limits-cache-'));

function writeCache(dir: string, limits: unknown): void {
  writeFileSync(limitsCachePath(dir), JSON.stringify({ version: 1, fetchedAt: '2026-09-14T12:00:00.000Z', limits }));
}

const PAYLOAD = {
  five_hour: { utilization: 69, resets_at: '2026-09-14T23:00:00.000Z' },
  seven_day: { utilization: 34, resets_at: '2026-09-16T13:00:00.000Z' },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 69,
      severity: 'normal',
      resets_at: '2026-09-14T23:00:00.000Z',
      is_active: true,
    },
  ],
};

function poller(configDir: string | null, fetchLimitsImpl: () => Promise<unknown>): LimitsPoller {
  return new LimitsPoller({
    getToken: async () => 'token',
    fetchLimitsImpl,
    configDir,
    now: () => Date.parse('2026-09-14T12:00:00.000Z'),
  });
}

describe('limits cache (§23.19)', () => {
  it('a restarted daemon serves the previous numbers, marked stale, before its first poll', async () => {
    const dir = temp();
    const first = poller(dir, async () => PAYLOAD);
    await first.refresh();
    expect(first.snapshot().limits[0]?.percent).toBe(69);

    // A new process: nothing in memory, and the very first poll is rate-limited.
    const restarted = poller(dir, async () => {
      throw new LimitsError('network', 'usage request returned HTTP 429', { status: 429 });
    });
    const before = restarted.snapshot();
    expect(before.limits[0]?.percent).toBe(69);
    expect(before.stale).toBe(true);
    expect(before.fetchedAt).not.toBeNull();

    // And the 429 leaves those numbers in place rather than blanking them.
    await restarted.refresh();
    expect(restarted.snapshot().limits[0]?.percent).toBe(69);
    expect(restarted.snapshot().error?.message).toMatch(/429/);
  });

  it('caches the normalized snapshot only — never the raw upstream payload', async () => {
    const dir = temp();
    await poller(dir, async () => PAYLOAD).refresh();
    const cached = JSON.parse(readFileSync(limitsCachePath(dir), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(cached).sort()).toEqual(['extraUsage', 'fetchedAt', 'legacyWindows', 'limits', 'version']);
    // `raw` is the upstream body; the cache exists to answer with percentages, not to keep
    // a copy of the account payload on disk.
    expect(cached['raw']).toBeUndefined();
    expect(cached['version']).toBe(1);
  });

  it('ignores a cache that is absent, corrupt, or of another version', () => {
    const dir = temp();
    expect(readCachedSnapshot(dir)).toBeNull();
    writeFileSync(limitsCachePath(dir), 'not json');
    expect(readCachedSnapshot(dir)).toBeNull();
    writeFileSync(limitsCachePath(dir), JSON.stringify({ version: 99, fetchedAt: 'x', limits: [] }));
    expect(readCachedSnapshot(dir)).toBeNull();
    // A cache with no fetchedAt is indistinguishable from "never fetched" — drop it.
    writeFileSync(limitsCachePath(dir), JSON.stringify({ version: 1, limits: [] }));
    expect(readCachedSnapshot(dir)).toBeNull();
  });

  it.each([
    ['a limit that is not an object', [42]],
    ['a limit with no id', [{ kind: 'session', percent: 10 }]],
    ['a limit with an empty id', [{ id: '', kind: 'session' }]],
    ['a limit with no kind', [{ id: 'session', percent: 10 }]],
    ['a string percent', [{ id: 'session', kind: 'session', percent: '10' }]],
    ['no limits at all', []],
  ])('drops the whole cache rather than serve %s', (_name, limits) => {
    const dir = temp();
    writeCache(dir, limits);
    expect(readCachedSnapshot(dir)).toBeNull();
  });

  it('drops a cache whose percent is a non-finite number', () => {
    const dir = temp();
    // `JSON.stringify` cannot produce this — it writes NaN as null — but `JSON.parse` reads
    // `1e999` back as Infinity, which is how a non-finite number actually reaches us.
    writeFileSync(
      limitsCachePath(dir),
      '{"version":1,"fetchedAt":"2026-09-14T12:00:00.000Z","limits":[{"id":"session","kind":"session","percent":1e999}]}',
    );
    expect(readCachedSnapshot(dir)).toBeNull();
  });

  it('keeps a good limit whose optional fields are missing, and drops a bad legacy window', () => {
    const dir = temp();
    writeFileSync(
      limitsCachePath(dir),
      JSON.stringify({
        version: 1,
        fetchedAt: '2026-09-14T12:00:00.000Z',
        limits: [{ id: 'session', kind: 'session' }],
        legacyWindows: { five_hour: { utilization: 69, resetsAt: null }, junk: { utilization: 'lots' } },
      }),
    );
    const restored = readCachedSnapshot(dir);
    expect(restored?.limits).toEqual([
      { id: 'session', kind: 'session', group: null, percent: null, severity: null, resetsAt: null, scope: null, isActive: false },
    ]);
    expect(restored?.legacyWindows).toEqual({ five_hour: { utilization: 69, resetsAt: null } });
  });

  it('is disabled without a configDir, so a CLI read never touches the daemon cache', async () => {
    const p = poller(null, async () => PAYLOAD);
    await p.refresh();
    expect(p.snapshot().limits[0]?.percent).toBe(69);
  });
});
