import { describe, expect, it } from 'vitest';
import { computeStatus, limitStatus, worstStatus } from '../src/limits/status.js';
import { normalizeLimits } from '../src/limits/normalize.js';
import type { NormalizedLimit } from '../src/limits/types.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const T = { warn: 80, critical: 95 };

function limit(over: Partial<NormalizedLimit>): NormalizedLimit {
  return {
    id: 'session',
    kind: 'session',
    group: 'session',
    percent: 0,
    severity: 'normal',
    resetsAt: null,
    scope: null,
    isActive: true,
    ...over,
  };
}

describe('limitStatus', () => {
  it('is ok below warn with normal severity', () => {
    expect(limitStatus(limit({ percent: 79 }), T)).toBe('ok');
  });

  it('warns at the warn threshold', () => {
    expect(limitStatus(limit({ percent: 80 }), T)).toBe('warn');
  });

  it('is critical at the critical threshold', () => {
    expect(limitStatus(limit({ percent: 95 }), T)).toBe('critical');
    expect(limitStatus(limit({ percent: 100 }), T)).toBe('critical');
  });

  it('warns on any non-normal severity even at 0%', () => {
    expect(limitStatus(limit({ percent: 0, severity: 'warning' }), T)).toBe('warn');
    expect(limitStatus(limit({ percent: 0, severity: 'brand_new' }), T)).toBe('warn');
  });

  it('is critical on a critical-like severity even at 0%', () => {
    for (const severity of ['critical', 'exceeded', 'blocked', 'locked', 'limit_reached']) {
      expect(limitStatus(limit({ percent: 0, severity }), T)).toBe('critical');
    }
    expect(limitStatus(limit({ percent: 0, severity: 'CRITICAL' }), T)).toBe('critical');
  });

  it('treats a null severity as normal and a null percent as no signal', () => {
    expect(limitStatus(limit({ percent: null, severity: null }), T)).toBe('ok');
    expect(limitStatus(limit({ percent: null, severity: 'critical' }), T)).toBe('critical');
  });

  it('honours custom thresholds', () => {
    expect(limitStatus(limit({ percent: 50 }), { warn: 40, critical: 60 })).toBe('warn');
    expect(limitStatus(limit({ percent: 60 }), { warn: 40, critical: 60 })).toBe('critical');
  });
});

describe('computeStatus', () => {
  it('keys byId and takes the worst as overall', () => {
    const report = computeStatus(
      [
        limit({ id: 'session', percent: 10 }),
        limit({ id: 'weekly_all', percent: 84 }),
        limit({ id: 'weekly_scoped:fable', percent: 99 }),
      ],
      T,
    );
    expect(report.byId).toEqual({ session: 'ok', weekly_all: 'warn', 'weekly_scoped:fable': 'critical' });
    expect(report.overall).toBe('critical');
  });

  it('is ok for an empty limits array', () => {
    expect(computeStatus([], T)).toEqual({ byId: {}, overall: 'ok' });
  });

  it('reports the live fixture as entirely ok', () => {
    const report = computeStatus(normalizeLimits(liveLimitsFixture()).limits, T);
    expect(report.overall).toBe('ok');
    expect(report.byId).toEqual({ session: 'ok', weekly_all: 'ok', 'weekly_scoped:fable': 'ok' });
  });
});

describe('worstStatus', () => {
  it('ranks ok < warn < critical', () => {
    expect(worstStatus('ok', 'warn')).toBe('warn');
    expect(worstStatus('critical', 'warn')).toBe('critical');
    expect(worstStatus('ok', 'ok')).toBe('ok');
  });
});
