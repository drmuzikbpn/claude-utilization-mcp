import { describe, expect, it } from 'vitest';
import { LEGACY_WINDOW_KEYS, limitId, normalizeLimits, toIsoZ } from '../src/limits/normalize.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

describe('normalizeLimits against the live fixture', () => {
  const raw = liveLimitsFixture();
  const n = normalizeLimits(raw);

  it('maps limits[] 1:1 from upstream', () => {
    expect(n.limits).toHaveLength((raw['limits'] as unknown[]).length);
    expect(n.limits.map((l) => l.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped']);
  });

  it('derives ids, appending the lower-cased scope model', () => {
    expect(n.limits.map((l) => l.id)).toEqual(['session', 'weekly_all', 'weekly_scoped:fable']);
  });

  it('carries integer percents from upstream', () => {
    expect(n.limits.map((l) => l.percent)).toEqual([5, 13, 10]);
    for (const l of n.limits) expect(Number.isInteger(l.percent)).toBe(true);
  });

  it('normalizes resetsAt through Date to ISO Z', () => {
    expect(n.limits[0]?.resetsAt).toBe('2026-09-13T18:00:00.114Z');
    expect(n.limits[1]?.resetsAt).toBe('2026-09-16T13:00:00.114Z');
  });

  it('carries group, severity, scope and isActive', () => {
    expect(n.limits[0]).toMatchObject({ group: 'session', severity: 'normal', scope: null, isActive: false });
    expect(n.limits[1]?.isActive).toBe(true);
    expect(n.limits[2]?.scope).toEqual({ model: 'Fable', surface: null });
  });

  it('promises only five_hour and seven_day in legacyWindows', () => {
    expect(Object.keys(n.legacyWindows).sort()).toEqual([...LEGACY_WINDOW_KEYS].sort());
    expect(n.legacyWindows['five_hour']).toEqual({ utilization: 5, resetsAt: '2026-09-13T18:00:00.114Z' });
  });

  it('ignores unknown top-level keys including unknown_window_example', () => {
    expect(Object.keys(n.legacyWindows)).not.toContain('unknown_window_example');
    expect(Object.keys(n)).toEqual(['limits', 'legacyWindows', 'extraUsage']);
  });

  it('normalizes extraUsage', () => {
    expect(n.extraUsage).toEqual({ isEnabled: false, utilization: null, spendLimitReached: true });
  });
});

describe('normalizeLimits tolerance', () => {
  it('never throws on junk input', () => {
    for (const junk of [null, undefined, 42, 'x', [], { limits: 'nope' }]) {
      expect(() => normalizeLimits(junk)).not.toThrow();
    }
    expect(normalizeLimits(null).limits).toEqual([]);
  });

  it('passes unknown severity strings straight through', () => {
    const n = normalizeLimits({ limits: [{ kind: 'session', severity: 'brand_new_severity', percent: 1 }] });
    expect(n.limits[0]?.severity).toBe('brand_new_severity');
  });

  it('yields resetsAt null for missing or unparseable timestamps', () => {
    const n = normalizeLimits({
      limits: [
        { kind: 'a' },
        { kind: 'b', resets_at: null },
        { kind: 'c', resets_at: 'not a date' },
      ],
    });
    expect(n.limits.map((l) => l.resetsAt)).toEqual([null, null, null]);
  });

  it('drops entries with no kind and skips non-object entries', () => {
    const n = normalizeLimits({ limits: [{ percent: 3 }, 7, null, { kind: 'ok' }] });
    expect(n.limits.map((l) => l.id)).toEqual(['ok']);
  });

  it('yields percent null for non-numeric percents and rounds floats', () => {
    const n = normalizeLimits({ limits: [{ kind: 'a', percent: 'x' }, { kind: 'b', percent: 12.6 }] });
    expect(n.limits[0]?.percent).toBeNull();
    expect(n.limits[1]?.percent).toBe(13);
  });

  it('omits legacy windows that are null upstream', () => {
    expect(normalizeLimits({ limits: [], five_hour: null }).legacyWindows).toEqual({});
  });

  it('returns extraUsage null when absent', () => {
    expect(normalizeLimits({ limits: [] }).extraUsage).toBeNull();
  });
});

describe('limitId', () => {
  it('appends the lower-cased model only when present', () => {
    expect(limitId('weekly_scoped', { model: 'Opus 4.5', surface: null })).toBe('weekly_scoped:opus 4.5');
    expect(limitId('session', null)).toBe('session');
    expect(limitId('session', { model: null, surface: 'api' })).toBe('session');
  });
});

describe('toIsoZ', () => {
  it('converts offsets to Z and rejects junk', () => {
    expect(toIsoZ('2026-09-13T18:00:00.114379+00:00')).toBe('2026-09-13T18:00:00.114Z');
    expect(toIsoZ(null)).toBeNull();
    expect(toIsoZ('')).toBeNull();
    expect(toIsoZ(12)).toBeNull();
  });
});
