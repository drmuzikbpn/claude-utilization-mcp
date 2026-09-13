import { afterEach, describe, expect, it } from 'vitest';
import { formatStatusline, runStatusline } from '../src/statusline.js';
import { normalizeLimits } from '../src/limits/normalize.js';
import { computeStatus } from '../src/limits/status.js';
import type { SummaryBody } from '../src/hook.js';
import { startFakeDaemon, tempConfigDir, type FakeDaemon } from './helpers/fake-daemon.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const daemons: FakeDaemon[] = [];
const ESC = '\u001b';

afterEach(async () => {
  while (daemons.length > 0) {
    const d = daemons.pop();
    if (d !== undefined) await d.stop();
  }
});

async function daemon(): Promise<FakeDaemon> {
  const d = await startFakeDaemon();
  daemons.push(d);
  return d;
}

function summary(percents: Record<string, number>): SummaryBody {
  const limits = normalizeLimits(liveLimitsFixture()).limits.map((l) => ({
    ...l,
    percent: percents[l.id] ?? l.percent,
  }));
  return {
    limits: { limits },
    status: computeStatus(limits, { warn: 80, critical: 95 }),
    thresholds: { warn: 80, critical: 95 },
  };
}

async function line(d: FakeDaemon, color = false): Promise<string> {
  let out = '';
  const code = await runStatusline({
    stdin: '{"session_id":"s1"}',
    stdout: (t) => {
      out += t;
    },
    configDir: d.configDir,
    color,
  });
  expect(code).toBe(0);
  return out;
}

describe('formatStatusline', () => {
  it('renders the 5h and 7d segments', () => {
    expect(formatStatusline(summary({ session: 42, weekly_all: 61 }), false)).toBe('5h 42% · 7d 61%');
  });

  it('adds no colour at ok', () => {
    expect(formatStatusline(summary({ session: 42 }), true)).not.toContain(ESC);
  });

  it('colours yellow at warn and red at critical', () => {
    const warn = formatStatusline(summary({ session: 84, weekly_all: 10 }), true) ?? '';
    expect(warn).toContain(`${ESC}[33m5h 84%${ESC}[0m`);
    expect(warn).toContain('7d 10%');

    const critical = formatStatusline(summary({ session: 96 }), true) ?? '';
    expect(critical).toContain(`${ESC}[31m5h 96%${ESC}[0m`);
  });

  it('colours each segment by its own status', () => {
    const both = formatStatusline(summary({ session: 96, weekly_all: 84 }), true) ?? '';
    expect(both).toContain(`${ESC}[31m5h 96%`);
    expect(both).toContain(`${ESC}[33m7d 84%`);
  });

  it('renders "?%" for a null percent', () => {
    const s = summary({});
    s.limits.limits = s.limits.limits.map((l) => (l.id === 'session' ? { ...l, percent: null } : l));
    expect(formatStatusline(s, false)).toContain('5h ?%');
  });

  it('ignores resetsAt entirely, including null', () => {
    const s = summary({ session: 42, weekly_all: 61 });
    s.limits.limits = s.limits.limits.map((l) => ({ ...l, resetsAt: null }));
    expect(formatStatusline(s, false)).toBe('5h 42% · 7d 61%');
  });

  it('returns null when neither headline limit exists', () => {
    expect(formatStatusline({ limits: { limits: [] }, status: { byId: {}, overall: 'ok' }, thresholds: { warn: 80, critical: 95 } }, false)).toBeNull();
  });
});

describe('runStatusline', () => {
  it('prints the line against a live daemon', async () => {
    const d = await daemon();
    d.setPercents({ session: 42, weekly_all: 61 });
    expect(await line(d)).toBe('5h 42% · 7d 61%\n');
  });

  it('prints coloured output at warn', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    expect(await line(d, true)).toContain(`${ESC}[33m`);
  });

  it('prints nothing when the daemon is unreachable', async () => {
    let out = '';
    const code = await runStatusline({ stdout: (t) => (out += t), configDir: tempConfigDir() });
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('prints nothing when daemon.json points at a dead port', async () => {
    const d = await startFakeDaemon();
    const configDir = d.configDir;
    await d.stop();
    let out = '';
    expect(await runStatusline({ stdout: (t) => (out += t), configDir })).toBe(0);
    expect(out).toBe('');
  });

  it('prints nothing for a body that is not a summary', async () => {
    let out = '';
    const code = await runStatusline({
      stdout: (t) => (out += t),
      configDir: tempConfigDir(),
      client: { get: async () => ({ nope: 1 }) },
    });
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('honours NO_COLOR', async () => {
    const d = await daemon();
    d.setPercents({ session: 96 });
    let out = '';
    await runStatusline({ stdout: (t) => (out += t), configDir: d.configDir, env: { NO_COLOR: '1' } });
    expect(out).not.toContain(ESC);
    expect(out).toBe('5h 96% · 7d 13%\n');
  });

  it('tolerates malformed stdin', async () => {
    const d = await daemon();
    let out = '';
    await runStatusline({ stdin: 'garbage', stdout: (t) => (out += t), configDir: d.configDir, color: false });
    expect(out).toBe('5h 5% · 7d 13%\n');
  });
});
