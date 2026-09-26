/**
 * §23.36: rate limits observed from Claude Code's own statusline input.
 *
 * The usage endpoint allows this daemon only a few calls an hour (§23.32–§23.35). Claude Code
 * already reads the 5-hour and 7-day utilisation from the headers of every model response
 * and passes them to the statusline command as `rate_limits`, so the daemon can take them
 * from there at no upstream cost and keep the endpoint for what only it has.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/clients/http.js';
import { writeJsonFile } from '../src/config.js';
import {
  LimitsPoller,
  OBSERVATION_TTL_MS,
  OBSERVED_UPSTREAM_INTERVAL_MS,
} from '../src/limits/poller.js';
import { OBSERVE_DEDUPE_MS, OBSERVE_PATH, runObserve } from '../src/observe.js';
import { createServer, type UsageServer } from '../src/server/index.js';
import { runStatusline } from '../src/statusline.js';
import { FakeTimers, flush } from './helpers/fake-timers.js';
import { testConfig } from './helpers/fakes.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const EPOCH = Date.parse('2026-09-26T08:00:00.000Z');
const INTERVAL = 120_000;
const secs = (ms: number): number => Math.floor(ms / 1000);

function rateLimits(fiveHour: number, sevenDay: number, resetMs = EPOCH + 3 * 3_600_000) {
  return {
    five_hour: { used_percentage: fiveHour, resets_at: secs(resetMs) },
    seven_day: { used_percentage: sevenDay, resets_at: secs(EPOCH + 5 * 86_400_000) },
  };
}

function harness(opts: { upstream?: boolean } = {}) {
  const timers = new FakeTimers();
  let calls = 0;
  let failing = opts.upstream === false;
  const poller = new LimitsPoller({
    intervalMs: INTERVAL,
    timers,
    now: () => EPOCH + timers.clock,
    getToken: async () => 'tok',
    fetchLimitsImpl: async () => {
      calls += 1;
      if (failing) throw new Error('no upstream in this test');
      return liveLimitsFixture();
    },
  });
  return {
    poller,
    timers,
    calls: () => calls,
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
}

const byId = (poller: LimitsPoller, id: string) => poller.snapshot().limits.find((l) => l.id === id);

describe('LimitsPoller.observe (§23.36)', () => {
  it('serves session and weekly_all from a statusline observation', () => {
    const h = harness();
    expect(h.poller.observe(rateLimits(10.4, 52))).toEqual({ accepted: true });
    const session = byId(h.poller, 'session');
    expect(session).toMatchObject({
      percent: 10,
      source: 'statusline',
      asOf: new Date(EPOCH).toISOString(),
      resetsAt: new Date(secs(EPOCH + 3 * 3_600_000) * 1000).toISOString(),
    });
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 52, source: 'statusline', group: 'weekly' });
  });

  it('accepts resets_at as an ISO string too', () => {
    const h = harness();
    const iso = '2026-09-26T11:00:00.000Z';
    h.poller.observe({ five_hour: { used_percentage: 5, resets_at: iso } });
    expect(byId(h.poller, 'session')?.resetsAt).toBe(iso);
  });

  it('garbage never overwrites good data', () => {
    const h = harness();
    h.poller.observe(rateLimits(40, 50));
    const garbage: unknown[] = [
      null,
      'nope',
      [],
      {},
      { five_hour: null },
      { five_hour: { used_percentage: 150, resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: -1, resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: '40', resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: Number.NaN, resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: 12, resets_at: 'soon' } },
      { five_hour: { used_percentage: 12, resets_at: secs(EPOCH) }, seven_day: { used_percentage: 999 } },
    ];
    for (const input of garbage) {
      const result = h.poller.observe(input);
      expect(result.accepted, JSON.stringify(input)).toBe(false);
    }
    expect(byId(h.poller, 'session')?.percent).toBe(40);
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(50);
  });

  it('an observation expires at its own resets_at, even inside the freshness window', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.poller.stop();
    const upstreamSession = byId(h.poller, 'session')?.percent;

    h.poller.observe(rateLimits(77, 50, EPOCH + 5 * 60_000));
    expect(byId(h.poller, 'session')).toMatchObject({ percent: 77, source: 'statusline' });

    h.timers.clock += 5 * 60_000; // exactly the reset, well inside OBSERVATION_TTL_MS
    expect(5 * 60_000).toBeLessThan(OBSERVATION_TTL_MS);
    expect(byId(h.poller, 'session')).toMatchObject({ percent: upstreamSession, source: 'upstream' });
    // The 7-day window has not reset, so it is still served from the observation.
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 50, source: 'statusline' });
  });

  it(`an observation expires after OBSERVATION_TTL_MS`, () => {
    const h = harness();
    h.poller.observe(rateLimits(20, 30));
    h.timers.clock += OBSERVATION_TTL_MS - 1;
    expect(byId(h.poller, 'session')?.source).toBe('statusline');
    h.timers.clock += 1;
    expect(byId(h.poller, 'session')).toBeUndefined();
    expect(h.poller.snapshot().limits).toEqual([]);
  });

  it('newer wins per limit id, giving a mixed-source snapshot', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.poller.stop();

    h.timers.clock += 60_000;
    h.poller.observe(rateLimits(11, 22));
    const mixed = h.poller.snapshot();
    expect(mixed.limits.find((l) => l.id === 'session')).toMatchObject({ percent: 11, source: 'statusline' });
    expect(mixed.limits.find((l) => l.id === 'weekly_all')).toMatchObject({ percent: 22, source: 'statusline' });
    const scoped = mixed.limits.find((l) => l.id.startsWith('weekly_scoped'));
    expect(scoped).toMatchObject({ source: 'upstream', asOf: new Date(EPOCH).toISOString() });
    // Observed values have no upstream severity to lean on.
    expect(mixed.limits.find((l) => l.id === 'session')?.severity).toBeNull();

    // A newer upstream fetch wins back both ids.
    h.timers.clock += 60_000;
    await h.poller.refresh();
    expect(byId(h.poller, 'session')?.source).toBe('upstream');
    expect(byId(h.poller, 'weekly_all')?.source).toBe('upstream');
  });

  it('statusline-only data: source and age on each limit, fetchedAt null, stale false', () => {
    const h = harness({ upstream: false });
    h.poller.observe(rateLimits(10, 52));
    const snap = h.poller.snapshot();
    expect(snap.fetchedAt).toBeNull();
    expect(snap.stale).toBe(false);
    expect(snap.raw).toBeNull();
    expect(snap.limits.map((l) => [l.id, l.source, l.asOf])).toEqual([
      ['session', 'statusline', new Date(EPOCH).toISOString()],
      ['weekly_all', 'statusline', new Date(EPOCH).toISOString()],
    ]);
  });

  it('a fresh observation clears stale even while upstream is failing', async () => {
    const h = harness({ upstream: false });
    h.poller.start();
    await flush();
    h.poller.stop();
    h.poller.observe(rateLimits(10, 52));
    expect(h.poller.snapshot().stale).toBe(false);
    expect(h.poller.snapshot().error?.code).toBe('network');
  });

  it('notifies onChange when an observation changes the body', () => {
    const h = harness();
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });
    h.poller.observe(rateLimits(10, 52));
    h.poller.observe(rateLimits(10, 52));
    expect(fired).toBe(1);
    h.poller.observe(rateLimits(11, 52));
    expect(fired).toBe(2);
  });

  it('legacyWindows mirrors a fresh observation, unrounded, and falls back once it expires', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.poller.stop();
    const upstreamLegacy = h.poller.snapshot().legacyWindows;

    h.poller.observe(rateLimits(41.6, 63.2));
    const legacy = h.poller.snapshot().legacyWindows;
    expect(legacy['five_hour']).toEqual({ utilization: 41.6, resetsAt: byId(h.poller, 'session')?.resetsAt });
    expect(legacy['seven_day']).toEqual({ utilization: 63.2, resetsAt: byId(h.poller, 'weekly_all')?.resetsAt });

    h.timers.clock += OBSERVATION_TTL_MS;
    expect(h.poller.snapshot().legacyWindows).toEqual(upstreamLegacy);
  });

  it('when an observation lapses, push clients hear it: onChange fires and stale returns', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.setFailing(true);
    await h.timers.advance(INTERVAL);
    expect(h.poller.snapshot().stale).toBe(true);

    h.poller.observe(rateLimits(41, 63));
    expect(h.poller.snapshot().stale).toBe(false);
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });

    // Nothing else changes the body between now and the lapse; only the expiry wake-up can.
    await h.timers.advance(OBSERVATION_TTL_MS - 1);
    expect(fired).toBe(0);
    await h.timers.advance(1);
    expect(fired).toBe(1);
    expect(h.poller.snapshot().stale).toBe(true);
    expect(byId(h.poller, 'session')?.source).toBe('upstream');

    // stop() takes a pending expiry wake-up with it.
    h.poller.observe(rateLimits(42, 63));
    h.poller.stop();
    expect(h.timers.pendingCount).toBe(0);
  });

  it('polls upstream at most hourly while observations are fresh, adaptive again after', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    expect(h.timers.nextDelay).toBe(INTERVAL);

    h.poller.observe(rateLimits(10, 52));
    await h.timers.advance(INTERVAL);
    expect(h.calls()).toBe(2);
    // The poll, plus the §23.37 wake-up for when the observation lapses.
    expect(h.timers.delays).toEqual([OBSERVATION_TTL_MS - INTERVAL, OBSERVED_UPSTREAM_INTERVAL_MS]);

    // Observation long gone by the time the hourly poll lands: back to the base interval.
    await h.timers.advance(OBSERVED_UPSTREAM_INTERVAL_MS);
    expect(h.calls()).toBe(3);
    expect(h.timers.nextDelay).toBe(INTERVAL);
    h.poller.stop();
  });
});

// --- the HTTP route ---------------------------------------------------------

const servers: UsageServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function serve(poller: LimitsPoller): Promise<string> {
  const server = createServer({ config: testConfig(), limits: poller, version: '9.9.9' });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${String(port)}`;
}

describe(`POST ${OBSERVE_PATH}`, () => {
  it('needs the bearer token even from loopback', async () => {
    const base = await serve(harness().poller);
    const res = await fetch(`${base}${OBSERVE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rateLimits(10, 52)),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a good body and GET /v1/limits reflects it; garbage is a 400', async () => {
    const h = harness();
    const base = await serve(h.poller);
    const client = new DaemonClient({ baseUrl: base, token: 'test-bearer-token' });
    await client.post(OBSERVE_PATH, rateLimits(10, 52));
    const body = (await client.get('/v1/limits')) as { limits: Array<{ id: string; percent: number; source: string }> };
    expect(body.limits.find((l) => l.id === 'session')).toMatchObject({ percent: 10, source: 'statusline' });

    const err = await client.post(OBSERVE_PATH, { five_hour: { used_percentage: 500 } }).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    expect(byId(h.poller, 'session')?.percent).toBe(10);
  });
});

// --- the `observe` subcommand -----------------------------------------------

function observeHarness() {
  const configDir = mkdtempSync(join(tmpdir(), 'cu-observe-'));
  writeJsonFile(join(configDir, 'config.json'), { auth: { token: 'test-bearer-token' } });
  const posts: Array<{ path: string; body: unknown; token: string | undefined }> = [];
  let clock = EPOCH;
  let fail = false;
  const run = (stdin: string) =>
    runObserve({
      stdin,
      configDir,
      now: () => clock,
      post: async (path, body, token) => {
        if (fail) throw new Error('daemon down');
        posts.push({ path, body, token });
      },
    });
  return {
    run,
    posts,
    advance: (ms: number) => {
      clock += ms;
    },
    failPosts: () => {
      fail = true;
    },
  };
}

const statuslineInput = (limits: unknown) => JSON.stringify({ session_id: 's1', model: { id: 'x' }, rate_limits: limits });

describe('claude-usage observe', () => {
  it('POSTs rate_limits with the bearer token', async () => {
    const h = observeHarness();
    expect(await h.run(statuslineInput(rateLimits(10, 52)))).toBe(0);
    expect(h.posts).toEqual([{ path: OBSERVE_PATH, body: rateLimits(10, 52), token: 'test-bearer-token' }]);
  });

  it('does nothing without rate_limits, or with unparseable stdin', async () => {
    const h = observeHarness();
    expect(await h.run(JSON.stringify({ session_id: 's1' }))).toBe(0);
    expect(await h.run('not json')).toBe(0);
    expect(await h.run('')).toBe(0);
    expect(h.posts).toHaveLength(0);
  });

  it(`skips a byte-identical payload sent within OBSERVE_DEDUPE_MS`, async () => {
    const h = observeHarness();
    await h.run(statuslineInput(rateLimits(10, 52)));
    h.advance(OBSERVE_DEDUPE_MS - 1);
    await h.run(statuslineInput(rateLimits(10, 52)));
    expect(h.posts).toHaveLength(1);

    // A change goes straight through…
    await h.run(statuslineInput(rateLimits(11, 52)));
    expect(h.posts).toHaveLength(2);
    // …and the same payload again once the dedupe window has passed.
    h.advance(OBSERVE_DEDUPE_MS);
    await h.run(statuslineInput(rateLimits(11, 52)));
    expect(h.posts).toHaveLength(3);
  });

  it('is silent and exits 0 when the daemon is down, and retries next time', async () => {
    const h = observeHarness();
    h.failPosts();
    expect(await h.run(statuslineInput(rateLimits(10, 52)))).toBe(0);
    expect(h.posts).toHaveLength(0);
  });
});

describe('claude-usage statusline forwards rate_limits (§23.36)', () => {
  it('observes as a side effect of rendering', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cu-sl-'));
    const seen: unknown[] = [];
    await runStatusline({
      stdin: statuslineInput(rateLimits(10, 52)),
      configDir,
      stdout: () => undefined,
      client: { get: async () => ({}) },
      observe: async (stdin) => {
        seen.push(JSON.parse(stdin));
        return 0;
      },
    });
    expect(seen).toHaveLength(1);
  });
});
