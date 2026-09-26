/**
 * §23.32: an upstream 429 is its own error, and its `Retry-After` is honoured.
 *
 * Found live: the usage endpoint answered `HTTP 429` with `retry-after: 3023` for over eleven
 * hours. The daemon reported it as a generic `network` error and kept retrying on its own
 * 10-minute backoff — well inside the window it had just been told to stay out of — and every
 * auto-update restart started a fresh poll immediately. Callers saw `error network` with
 * eleven-hour-old numbers and no way to tell that nothing was wrong with the network.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchLimits, type FetchLike } from '../src/limits/client.js';
import { defaultConfig } from '../src/config.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  LimitsPoller,
  MAX_ADAPTIVE_INTERVAL_MS,
  MAX_RETRY_AFTER_MS,
  MIN_POLL_INTERVAL_MS,
  RELAX_AFTER_SUCCESSES,
  REFRESH_MIN_INTERVAL_MS,
  effectivePollIntervalMs,
  limitsCachePath,
} from '../src/limits/poller.js';
import { LimitsError } from '../src/limits/types.js';
import { FakeTimers, flush } from './helpers/fake-timers.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN';
const EPOCH = Date.parse('2026-09-25T10:00:00.000Z');
const INTERVAL = 60_000;

function respond429(headers: Record<string, string> | null): FetchLike {
  return async () => ({
    ok: false,
    status: 429,
    text: async () => '{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}',
    ...(headers === null
      ? {}
      : { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } }),
  });
}

async function rejection(p: Promise<unknown>): Promise<LimitsError> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LimitsError);
  return err as LimitsError;
}

describe('fetchLimits on HTTP 429', () => {
  it('maps it to rate_limited and reads Retry-After in seconds', async () => {
    const err = await rejection(fetchLimits(TOKEN, respond429({ 'retry-after': '3023' })));
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3_023_000);
    expect(err.message).not.toContain(TOKEN);
  });

  it('reads an HTTP-date Retry-After relative to now', async () => {
    const err = await rejection(
      fetchLimits(TOKEN, respond429({ 'retry-after': 'Fri, 25 Sep 2026 10:05:00 GMT' }), { now: () => EPOCH }),
    );
    expect(err.retryAfterMs).toBe(300_000);
  });

  it.each([
    ['no headers object', null],
    ['no Retry-After', {}],
    ['a garbage Retry-After', { 'retry-after': 'soon' }],
    ['a negative Retry-After', { 'retry-after': '-5' }],
  ])('still says rate_limited with %s, just without a delay', async (_label, headers) => {
    const err = await rejection(fetchLimits(TOKEN, respond429(headers)));
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBeUndefined();
  });
});

interface Harness {
  poller: LimitsPoller;
  timers: FakeTimers;
  calls: () => number;
  setResult: (fn: () => Promise<unknown>) => void;
}

function harness(configDir: string | null = null): Harness {
  const timers = new FakeTimers();
  let calls = 0;
  let result: () => Promise<unknown> = async () => liveLimitsFixture();
  const poller = new LimitsPoller({
    intervalMs: INTERVAL,
    timers,
    now: () => EPOCH + timers.clock,
    getToken: async () => 'tok',
    fetchLimitsImpl: async () => {
      calls += 1;
      return result();
    },
    configDir,
  });
  return {
    poller,
    timers,
    calls: () => calls,
    setResult: (fn) => {
      result = fn;
    },
  };
}

const rateLimited = (retryAfterMs?: number) => () =>
  Promise.reject(
    new LimitsError('rate_limited', 'usage request returned HTTP 429', {
      status: 429,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }),
  );

describe('LimitsPoller on upstream 429', () => {
  it('waits out Retry-After instead of retrying on its own backoff', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.setResult(rateLimited(3_023_000));
    await h.timers.advance(INTERVAL);
    expect(h.calls()).toBe(2);
    expect(h.timers.nextDelay).toBe(3_023_000);

    // Nothing inside the window, even though the 10-min backoff cap has long passed.
    await h.timers.advance(3_023_000 - 1);
    expect(h.calls()).toBe(2);
    h.setResult(async () => liveLimitsFixture());
    await h.timers.advance(1);
    expect(h.calls()).toBe(3);
    expect(h.poller.snapshot().error).toBeNull();
    expect(h.poller.snapshot().stale).toBe(false);
    h.poller.stop();
  });

  it('reports a rate_limited error with retryAt, a readable message and a hint, keeping last-good numbers', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.setResult(rateLimited(3_023_000));
    await h.timers.advance(INTERVAL);

    const snap = h.poller.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.limits.length).toBeGreaterThan(0);
    const retryAt = new Date(EPOCH + INTERVAL + 3_023_000).toISOString();
    expect(snap.error).toMatchObject({ code: 'rate_limited', retryAt });
    expect(snap.error?.message).toMatch(/HTTP 429/);
    expect(snap.error?.message).toContain(retryAt);
    expect(snap.error?.hint).toMatch(/retr/i);
    h.poller.stop();
  });

  it('falls back to the normal backoff when there is no Retry-After', async () => {
    const h = harness();
    h.setResult(rateLimited());
    h.poller.start();
    await flush();
    expect(h.poller.snapshot().error?.code).toBe('rate_limited');
    expect(h.poller.snapshot().error?.retryAt).toBeUndefined();
    expect(h.timers.nextDelay).toBe(INTERVAL * 2);
    h.poller.stop();
  });

  it(`caps an absurd Retry-After at MAX_RETRY_AFTER_MS`, async () => {
    const h = harness();
    h.setResult(rateLimited(30 * 24 * 3_600_000));
    h.poller.start();
    await flush();
    expect(h.timers.nextDelay).toBe(MAX_RETRY_AFTER_MS);
    h.poller.stop();
  });

  it('refresh() inside the window does not call upstream and returns the rate_limited snapshot', async () => {
    const h = harness();
    h.setResult(rateLimited(3_023_000));
    h.poller.start();
    await flush();
    expect(h.calls()).toBe(1);

    await h.timers.advance(60_000);
    const { rateLimited: throttled, snapshot } = await h.poller.refresh();
    expect(throttled).toBe(false);
    expect(h.calls()).toBe(1);
    expect(snapshot.error?.code).toBe('rate_limited');
    h.poller.stop();
  });

  it('a restarted poller honours the previous process’s Retry-After', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-429-'));
    const first = harness(dir);
    first.poller.start();
    await flush();
    first.setResult(rateLimited(3_000_000));
    await first.timers.advance(INTERVAL);
    first.poller.stop();

    const onDisk = JSON.parse(readFileSync(limitsCachePath(dir), 'utf8')) as Record<string, unknown>;
    expect(onDisk['rateLimitedUntil']).toBe(new Date(EPOCH + INTERVAL + 3_000_000).toISOString());
    // The last good numbers are still there alongside it.
    expect(Array.isArray(onDisk['limits'])).toBe(true);
    expect((onDisk['limits'] as unknown[]).length).toBeGreaterThan(0);

    // Second process, 10 min later: no immediate poll, and the restored error says why.
    const second = harness(dir);
    second.timers.clock = INTERVAL + 600_000;
    second.poller.start();
    await flush();
    expect(second.calls()).toBe(0);
    expect(second.poller.snapshot().error?.code).toBe('rate_limited');
    expect(second.poller.snapshot().limits.length).toBeGreaterThan(0);
    expect(second.timers.nextDelay).toBe(3_000_000 - 600_000);

    await second.timers.advance(3_000_000 - 600_000);
    expect(second.calls()).toBe(1);
    expect(second.poller.snapshot().error).toBeNull();
    second.poller.stop();

    // A success clears the persisted window.
    const after = JSON.parse(readFileSync(limitsCachePath(dir), 'utf8')) as Record<string, unknown>;
    expect(after['rateLimitedUntil']).toBeUndefined();
  });

  it('ignores a persisted window that has already passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-429-'));
    const first = harness(dir);
    first.setResult(rateLimited(60_000));
    first.poller.start();
    await flush();
    first.poller.stop();

    const second = harness(dir);
    second.timers.clock = 120_000;
    second.poller.start();
    await flush();
    expect(second.calls()).toBe(1);
    second.poller.stop();
  });
});

describe('staying under the upstream budget (§23.33)', () => {
  it('clamps a configured poll interval below MIN_POLL_INTERVAL_MS', () => {
    expect(effectivePollIntervalMs(60_000)).toBe(MIN_POLL_INTERVAL_MS);
    expect(effectivePollIntervalMs(MIN_POLL_INTERVAL_MS + 1)).toBe(MIN_POLL_INTERVAL_MS + 1);
  });

  it('defaults new configs to DEFAULT_POLL_INTERVAL_MS, which is at least the floor', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(MIN_POLL_INTERVAL_MS);
    expect(defaultConfig().pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('a restart with a fresh cached snapshot waits out the interval instead of polling at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-budget-'));
    const first = harness(dir);
    first.poller.start();
    await flush();
    first.poller.stop();

    const second = harness(dir);
    second.timers.clock = 20_000;
    second.poller.start();
    await flush();
    expect(second.calls()).toBe(0);
    expect(second.timers.nextDelay).toBe(INTERVAL - 20_000);
    await second.timers.advance(INTERVAL - 20_000);
    expect(second.calls()).toBe(1);
    second.poller.stop();
  });

  it('a restart with an old cached snapshot polls at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-budget-'));
    const first = harness(dir);
    first.poller.start();
    await flush();
    first.poller.stop();

    const second = harness(dir);
    second.timers.clock = INTERVAL + 1;
    second.poller.start();
    await flush();
    expect(second.calls()).toBe(1);
    second.poller.stop();
  });

  it('after a 429 it polls at twice the interval, and relaxes back after a run of successes', async () => {
    const h = harness();
    h.setResult(rateLimited());
    h.poller.start();
    await flush();
    h.setResult(async () => liveLimitsFixture());
    await h.timers.advance(h.timers.nextDelay ?? 0);
    expect(h.poller.snapshot().error).toBeNull();
    expect(h.timers.nextDelay).toBe(INTERVAL * 2);

    for (let i = 1; i < RELAX_AFTER_SUCCESSES; i += 1) await h.timers.advance(h.timers.nextDelay ?? 0);
    expect(h.timers.nextDelay).toBe(INTERVAL);
    h.poller.stop();
  });

  it('keeps slowing down on repeated 429s, up to MAX_ADAPTIVE_INTERVAL_MS', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    for (let i = 0; i < 10; i += 1) {
      h.setResult(rateLimited());
      await h.timers.advance(h.timers.nextDelay ?? 0);
      h.setResult(async () => liveLimitsFixture());
      await h.timers.advance(h.timers.nextDelay ?? 0);
    }
    expect(h.timers.nextDelay).toBe(MAX_ADAPTIVE_INTERVAL_MS);
    h.poller.stop();
  });

  it('refresh() within REFRESH_MIN_INTERVAL_MS of any upstream call is served from cache', async () => {
    // Not started, so only refresh() calls upstream and the clock can be moved freely.
    const h = harness();
    await h.poller.refresh();
    expect(h.calls()).toBe(1);

    h.timers.clock += REFRESH_MIN_INTERVAL_MS - 1;
    const early = await h.poller.refresh();
    expect(early.rateLimited).toBe(true);
    expect(early.snapshot.limits.length).toBeGreaterThan(0);
    expect(h.calls()).toBe(1);

    h.timers.clock += 1;
    const late = await h.poller.refresh();
    expect(late.rateLimited).toBe(false);
    expect(h.calls()).toBe(2);
  });

  it('a scheduled poll counts against the refresh floor too', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    expect((await h.poller.refresh()).rateLimited).toBe(true);
    expect(h.calls()).toBe(1);
    h.poller.stop();
  });
});

describe('state transitions are logged at the default level (§23.35)', () => {
  function logged(configDir: string | null = null) {
    const timers = new FakeTimers();
    const lines: string[] = [];
    let result: () => Promise<unknown> = async () => liveLimitsFixture();
    const poller = new LimitsPoller({
      intervalMs: INTERVAL,
      timers,
      now: () => EPOCH + timers.clock,
      getToken: async () => 'tok',
      fetchLimitsImpl: async () => result(),
      notice: (line) => lines.push(line),
      configDir,
    });
    return {
      poller,
      timers,
      lines,
      setResult: (fn: () => Promise<unknown>) => {
        result = fn;
      },
    };
  }

  it('ok → rate_limited → ok, one line each, with retryAt', async () => {
    const h = logged();
    h.poller.start();
    await flush();
    expect(h.lines).toEqual(['limits: ok']);

    h.setResult(rateLimited(3_600_000));
    await h.timers.advance(INTERVAL);
    const retryAt = new Date(EPOCH + INTERVAL + 3_600_000).toISOString();
    expect(h.lines).toEqual(['limits: ok', `limits: rate_limited by Anthropic (HTTP 429) — next attempt after ${retryAt}`]);

    h.setResult(async () => liveLimitsFixture());
    await h.timers.advance(3_600_000);
    expect(h.lines.at(-1)).toBe('limits: ok');
    expect(h.lines).toHaveLength(3);

    // Steady state is silent.
    await h.timers.advance(INTERVAL * 5);
    expect(h.lines).toHaveLength(3);
    h.poller.stop();
  });

  it('logs a re-armed window (a new retryAt), but not a repeat of the same state', async () => {
    const h = logged();
    h.setResult(rateLimited(3_600_000));
    h.poller.start();
    await flush();
    await h.timers.advance(3_600_000);
    expect(h.lines).toHaveLength(2);
    expect(h.lines[0]).toContain(new Date(EPOCH + 3_600_000).toISOString());
    expect(h.lines[1]).toContain(new Date(EPOCH + 7_200_000).toISOString());

    h.setResult(() => Promise.reject(new LimitsError('network', 'boom')));
    await h.timers.advance(3_600_000);
    await h.timers.advance(h.timers.nextDelay ?? 0);
    expect(h.lines.slice(2)).toEqual(['limits: fetch failing (network) — boom']);
    h.poller.stop();
  });

  it('logs a 429 window restored from a previous process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-notice-'));
    const first = logged(dir);
    first.setResult(rateLimited(3_600_000));
    first.poller.start();
    await flush();
    first.poller.stop();

    const second = logged(dir);
    second.timers.clock = 60_000;
    second.poller.start();
    await flush();
    expect(second.lines).toEqual([
      `limits: rate_limited by Anthropic (HTTP 429) — next attempt after ${new Date(EPOCH + 3_600_000).toISOString()} (window from a previous process)`,
    ]);
  });
});
