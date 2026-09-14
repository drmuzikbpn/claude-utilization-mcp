import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient, DaemonUnreachable } from '../src/clients/http.js';
import {
  formatNudge,
  HOOK_DEADLINE_MS,
  REGISTER_DEADLINE_MS,
  formatResetsAt,
  formatResetsIn,
  hookStatePath,
  parseHookStdin,
  pickHeadline,
  runHook,
  type SummaryBody,
} from '../src/hook.js';
import { normalizeLimits } from '../src/limits/normalize.js';
import { computeStatus } from '../src/limits/status.js';
import { startFakeDaemon, tempConfigDir, type FakeDaemon } from './helpers/fake-daemon.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const daemons: FakeDaemon[] = [];
const NOW = Date.parse('2026-09-13T14:00:00Z');

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

interface RunResult {
  code: number;
  out: string;
}

async function hook(d: FakeDaemon, over: { now?: number; debounceMinutes?: number } = {}): Promise<RunResult> {
  let out = '';
  const code = await runHook({
    stdin: JSON.stringify({ session_id: 'sess-1', cwd: '/tmp/x', hook_event_name: 'UserPromptSubmit' }),
    stdout: (t) => {
      out += t;
    },
    configDir: d.configDir,
    now: () => over.now ?? NOW,
    ...(over.debounceMinutes === undefined ? {} : { debounceMinutes: over.debounceMinutes }),
  });
  return { code, out };
}

function summary(percents: Record<string, number>, severity?: Record<string, string>): SummaryBody {
  const limits = normalizeLimits(liveLimitsFixture()).limits.map((l) => ({
    ...l,
    percent: percents[l.id] ?? l.percent,
    severity: severity?.[l.id] ?? l.severity,
  }));
  return {
    limits: { limits },
    status: computeStatus(limits, { warn: 80, critical: 95 }),
    thresholds: { warn: 80, critical: 95 },
  };
}

describe('parseHookStdin', () => {
  it('parses session metadata and tolerates junk', () => {
    expect(parseHookStdin('{"session_id":"s1"}').session_id).toBe('s1');
    expect(parseHookStdin('not json')).toEqual({});
    expect(parseHookStdin('[1]')).toEqual({});
    expect(parseHookStdin(undefined)).toEqual({});
    expect(parseHookStdin('')).toEqual({});
  });
});

describe('formatResetsAt / formatResetsIn', () => {
  it('renders resetsAt: null as "resets: unknown"', () => {
    expect(formatResetsAt(null)).toBe('resets: unknown');
    expect(formatResetsIn(null, NOW)).toBe('resets: unknown');
    expect(formatResetsAt('garbage')).toBe('resets: unknown');
  });

  it('renders a countdown in minutes and hours', () => {
    expect(formatResetsIn('2026-09-13T14:41:00Z', NOW)).toBe('resets in 41m');
    expect(formatResetsIn('2026-09-13T16:05:00Z', NOW)).toBe('resets in 2h 05m');
    expect(formatResetsIn('2026-09-13T13:00:00Z', NOW)).toBe('resets in 0m');
  });
});

describe('pickHeadline', () => {
  it('takes the worst of session and weekly_all, session on a tie', () => {
    const s = summary({ session: 10, weekly_all: 96 });
    expect(pickHeadline(s.limits.limits, s.status.byId)?.limit.id).toBe('weekly_all');
    const t = summary({ session: 96, weekly_all: 96 });
    expect(pickHeadline(t.limits.limits, t.status.byId)?.limit.id).toBe('session');
  });

  it('ignores scoped limits as headline candidates', () => {
    const s = summary({ session: 1, weekly_all: 1, 'weekly_scoped:fable': 99 });
    expect(pickHeadline(s.limits.limits, s.status.byId)?.limit.id).toBe('session');
  });

  it('returns null when neither headline limit exists', () => {
    expect(pickHeadline([], {})).toBeNull();
  });
});

describe('formatNudge', () => {
  it('prints nothing when overall is ok', () => {
    expect(formatNudge(summary({}), NOW)).toBeNull();
  });

  it('prints the §7.1 warn line', () => {
    const line = formatNudge(summary({ session: 84, weekly_all: 61 }), NOW);
    expect(line).toBe(
      '⚠ Claude usage: 5h window 84% (resets ' +
        `${new Date(Date.parse('2026-09-13T18:00:00.114Z')).getHours().toString().padStart(2, '0')}:00), ` +
        '7d 61%. Prefer lighter work, smaller models, avoid large file reads.',
    );
  });

  it('prints the §7.1 critical line', () => {
    const s = summary({ session: 96 });
    s.limits.limits = s.limits.limits.map((l) => (l.id === 'session' ? { ...l, resetsAt: '2026-09-13T14:41:00Z' } : l));
    expect(formatNudge(s, NOW)).toBe(
      '🛑 Claude usage: 5h window 96% — resets in 41m. Defer non-urgent work; keep outputs short.',
    );
  });

  it('renders "resets: unknown" when resetsAt is null', () => {
    const s = summary({ session: 96 });
    s.limits.limits = s.limits.limits.map((l) => (l.id === 'session' ? { ...l, resetsAt: null } : l));
    expect(formatNudge(s, NOW)).toContain('resets: unknown');

    const w = summary({ session: 84, weekly_all: 61 });
    w.limits.limits = w.limits.limits.map((l) => (l.id === 'session' ? { ...l, resetsAt: null } : l));
    expect(formatNudge(w, NOW)).toContain('(resets: unknown)');
  });

  it('leads with the 7d window when it is the worse one', () => {
    const line = formatNudge(summary({ session: 5, weekly_all: 88 }), NOW);
    expect(line).toContain('7d window 88%');
    expect(line).toContain('5h 5%');
  });

  it('escalates on a critical-like severity even at a low percent', () => {
    expect(formatNudge(summary({ session: 3 }, { session: 'exceeded' }), NOW)).toMatch(/^🛑/);
  });

  it('renders "?%" for a null percent', () => {
    const s = summary({ weekly_all: 88 });
    s.limits.limits = s.limits.limits.map((l) => (l.id === 'session' ? { ...l, percent: null } : l));
    expect(formatNudge(s, NOW)).toContain('5h ?%');
  });
});

describe('runHook against a fake daemon', () => {
  it('prints nothing and exits 0 when overall is ok', async () => {
    const d = await daemon();
    const r = await hook(d);
    expect(r).toEqual({ code: 0, out: '' });
  });

  it('prints the warn line once and exits 0', async () => {
    const d = await daemon();
    d.setPercents({ session: 84, weekly_all: 61 });
    const r = await hook(d);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^⚠ Claude usage: 5h window 84% /);
    expect(r.out.endsWith('\n')).toBe(true);
  });

  it('prints the critical line', async () => {
    const d = await daemon();
    d.setPercents({ session: 96 });
    const r = await hook(d);
    expect(r.out).toMatch(/^🛑 Claude usage: 5h window 96% — resets/);
  });

  it('debounces the same (window, status) within the debounce window', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    expect((await hook(d)).out).not.toBe('');
    expect((await hook(d, { now: NOW + 60_000 })).out).toBe('');
    expect((await hook(d, { now: NOW + 9 * 60_000 })).out).toBe('');
  });

  it('prints again once the debounce window has elapsed', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    await hook(d);
    expect((await hook(d, { now: NOW + 10 * 60_000 })).out).not.toBe('');
  });

  it('always prints on a status change, even inside the debounce window', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    expect((await hook(d)).out).toMatch(/^⚠/);
    d.setPercents({ session: 96 });
    expect((await hook(d, { now: NOW + 1000 })).out).toMatch(/^🛑/);
  });

  it('prints again when the headline window changes at the same status', async () => {
    const d = await daemon();
    d.setPercents({ session: 84, weekly_all: 10 });
    await hook(d);
    d.setPercents({ session: 10, weekly_all: 88 });
    expect((await hook(d, { now: NOW + 1000 })).out).toContain('7d window 88%');
  });

  it('stores debounce state 0600 in the config dir', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    await hook(d);
    const path = hookStatePath(d.configDir);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(state).toMatchObject({ lastKey: 'session:warn', lastStatus: 'warn', lastPrintedAt: NOW });
  });

  it('recovers from a corrupt hook-state.json', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    writeFileSync(hookStatePath(d.configDir), 'not json');
    expect((await hook(d)).out).not.toBe('');
  });

  it('tolerates malformed stdin', async () => {
    const d = await daemon();
    d.setPercents({ session: 84 });
    let out = '';
    const code = await runHook({
      stdin: 'not json at all',
      stdout: (t) => {
        out += t;
      },
      configDir: d.configDir,
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(out).not.toBe('');
  });
});

describe('runHook failure paths', () => {
  it('prints nothing and exits 0 when the daemon is unreachable', async () => {
    let out = '';
    const code = await runHook({
      stdin: '{}',
      stdout: (t) => {
        out += t;
      },
      configDir: tempConfigDir(),
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('prints nothing and exits 0 when daemon.json points at a dead port', async () => {
    const d = await startFakeDaemon();
    const configDir = d.configDir;
    await d.stop();
    let out = '';
    const code = await runHook({ stdin: '{}', stdout: (t) => (out += t), configDir, now: () => NOW });
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('prints nothing and exits 0 when the request exceeds the deadline', async () => {
    let out = '';
    const slow: Pick<DaemonClient, 'get'> = {
      get: async () => {
        await new Promise((r) => setTimeout(r, 50));
        throw new DaemonUnreachable('GET /v1/summary failed: This operation was aborted');
      },
    };
    const code = await runHook({
      stdin: '{}',
      stdout: (t) => (out += t),
      configDir: tempConfigDir(),
      client: slow,
      deadlineMs: 10,
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('prints nothing and exits 0 when the body is not a summary', async () => {
    let out = '';
    const code = await runHook({
      stdin: '{}',
      stdout: (t) => (out += t),
      configDir: tempConfigDir(),
      client: { get: async () => ({ nonsense: true }) },
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('exits 0 even when the config dir is unwritable', async () => {
    const d = await daemon();
    d.setPercents({ session: 96 });
    // A regular file as the parent makes mkdir fail with ENOTDIR on every platform.
    // (Never use a path under Linux /proc here: procfs answers mkdir with ENOENT, which
    // sends Node's recursive mkdir into an infinite loop and wedges the whole worker.)
    const blocker = join(tempConfigDir(), 'not-a-dir');
    writeFileSync(blocker, '');
    let out = '';
    const code = await runHook({
      stdin: '{}',
      stdout: (t) => (out += t),
      configDir: join(blocker, 'config'),
      client: { get: async () => (await new DaemonClient({ baseUrl: `http://127.0.0.1:${d.port}` }).get('/v1/summary')) },
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/^🛑/);
  });
});

/**
 * §23.23: registration must not share the nudge's 200 ms budget.
 *
 * Found in QA: two throwaway sessions started 70 s apart from the same command line, one
 * registered in 4 s and the other not at all. The one that missed came up
 * `discovered: "transcript"` with `pid: null`, so a session-scope hard pause was refused 409
 * and a project-scope rule froze nothing — the whole control surface lost, silently, for the
 * life of that session.
 */
describe('SessionStart registration (§23.23)', () => {
  const start = { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp/x', source: 'startup' };

  it('registers with its own deadline, not the 200 ms nudge budget', async () => {
    const calls: { path: string; timeoutMs: number | undefined }[] = [];
    await runHook({
      stdin: JSON.stringify(start),
      configDir: tempConfigDir(),
      ppid: 4242,
      gitCommonDir: () => null,
      client: {
        get: async () => ({}),
        post: async (path, _body, opts) => {
          calls.push({ path, timeoutMs: opts?.timeoutMs });
          return {};
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/sessions/register');
    expect(calls[0]?.timeoutMs).toBe(REGISTER_DEADLINE_MS);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(HOOK_DEADLINE_MS);
  });

  it('re-registers when a later heartbeat is not accepted', async () => {
    // The daemon does not know this session: the SessionStart register missed its window.
    const posted: string[] = [];
    await runHook({
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp/x' }),
      configDir: tempConfigDir(),
      ppid: 4242,
      gitCommonDir: () => null,
      client: {
        get: async () => ({ paused: false }),
        post: async (path) => {
          posted.push(path);
          if (path.endsWith('/heartbeat')) throw new Error('404 not found');
          return {};
        },
      },
    });
    expect(posted).toEqual(['/v1/sessions/s1/heartbeat', '/v1/sessions/register']);
  });

  it('does not re-register when the heartbeat is accepted', async () => {
    const posted: string[] = [];
    await runHook({
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp/x' }),
      configDir: tempConfigDir(),
      ppid: 4242,
      gitCommonDir: () => null,
      client: {
        get: async () => ({ paused: false }),
        post: async (path) => {
          posted.push(path);
          return { ok: true };
        },
      },
    });
    expect(posted).toEqual(['/v1/sessions/s1/heartbeat']);
  });

  it('still exits 0 when the re-register also fails — the daemon may simply be gone', async () => {
    const code = await runHook({
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp/x' }),
      configDir: tempConfigDir(),
      ppid: 4242,
      gitCommonDir: () => null,
      client: {
        get: async () => {
          throw new Error('ECONNREFUSED');
        },
        post: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    expect(code).toBe(0);
  });
});
