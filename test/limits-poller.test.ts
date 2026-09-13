import { describe, expect, it } from 'vitest';
import { LimitsPoller, MAX_BACKOFF_MS } from '../src/limits/poller.js';
import { LimitsError } from '../src/limits/types.js';
import { NoCredentialsError } from '../src/credentials/types.js';
import { FakeTimers, flush } from './helpers/fake-timers.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const INTERVAL = 60_000;

interface Harness {
  poller: LimitsPoller;
  timers: FakeTimers;
  calls: string[];
  tokenReads: Array<{ fresh: boolean }>;
  setResult: (fn: (token: string) => Promise<unknown>) => void;
  setToken: (fn: () => Promise<string>) => void;
}

function harness(): Harness {
  const timers = new FakeTimers();
  const calls: string[] = [];
  const tokenReads: Array<{ fresh: boolean }> = [];
  let result: (token: string) => Promise<unknown> = async () => liveLimitsFixture();
  let tokenFn: () => Promise<string> = async () => 'tok';

  const poller = new LimitsPoller({
    intervalMs: INTERVAL,
    timers,
    now: () => 1_757_000_000_000 + timers.clock,
    getToken: async (o) => {
      tokenReads.push({ fresh: o?.fresh === true });
      return tokenFn();
    },
    fetchLimitsImpl: async (token) => {
      calls.push(token);
      return result(token);
    },
  });
  return {
    poller,
    timers,
    calls,
    tokenReads,
    setResult: (fn) => {
      result = fn;
    },
    setToken: (fn) => {
      tokenFn = fn;
    },
  };
}

const unauthorized = () => new LimitsError('unauthorized', 'usage request rejected with 401', { status: 401 });

describe('LimitsPoller interval', () => {
  it('fetches immediately on start and then every intervalMs', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.timers.nextDelay).toBe(INTERVAL);

    await h.timers.advance(INTERVAL);
    expect(h.calls).toHaveLength(2);
    await h.timers.advance(INTERVAL);
    expect(h.calls).toHaveLength(3);
    h.poller.stop();
  });

  it('stop() cancels the pending timer', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.poller.stop();
    expect(h.timers.pendingCount).toBe(0);
    await h.timers.advance(INTERVAL * 5);
    expect(h.calls).toHaveLength(1);
  });

  it('publishes a normalized snapshot', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    const snap = h.poller.snapshot();
    expect(snap.stale).toBe(false);
    expect(snap.error).toBeNull();
    expect(snap.fetchedAt).toMatch(/Z$/);
    expect(snap.limits.map((l) => l.id)).toEqual(['session', 'weekly_all', 'weekly_scoped:fable']);
    expect(snap.raw).toEqual(liveLimitsFixture());
    h.poller.stop();
  });

  it('starts with an empty, non-stale snapshot', () => {
    const h = harness();
    expect(h.poller.snapshot()).toMatchObject({ fetchedAt: null, stale: false, error: null, limits: [] });
  });
});

describe('LimitsPoller backoff', () => {
  it('doubles from the base interval and caps at 10 minutes', async () => {
    const h = harness();
    h.setResult(async () => {
      throw new LimitsError('network', 'boom');
    });
    h.poller.start();
    await flush();
    expect(h.timers.nextDelay).toBe(120_000);

    await h.timers.advance(120_000);
    expect(h.timers.nextDelay).toBe(240_000);
    await h.timers.advance(240_000);
    expect(h.timers.nextDelay).toBe(480_000);
    await h.timers.advance(480_000);
    expect(h.timers.nextDelay).toBe(MAX_BACKOFF_MS);
    await h.timers.advance(MAX_BACKOFF_MS);
    expect(h.timers.nextDelay).toBe(MAX_BACKOFF_MS);
    h.poller.stop();
  });

  it('resets to the base interval after a success', async () => {
    const h = harness();
    let fail = true;
    h.setResult(async () => {
      if (fail) throw new LimitsError('network', 'boom');
      return liveLimitsFixture();
    });
    h.poller.start();
    await flush();
    expect(h.timers.nextDelay).toBe(120_000);
    fail = false;
    await h.timers.advance(120_000);
    expect(h.timers.nextDelay).toBe(INTERVAL);
    h.poller.stop();
  });

  it('serves the last good value with stale:true and an error', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    const good = h.poller.snapshot();

    h.setResult(async () => {
      throw new LimitsError('network', 'boom');
    });
    await h.timers.advance(INTERVAL);
    const stale = h.poller.snapshot();
    expect(stale.stale).toBe(true);
    expect(stale.error).toEqual({ code: 'network', message: 'boom' });
    expect(stale.limits).toEqual(good.limits);
    expect(stale.fetchedAt).toBe(good.fetchedAt);
    h.poller.stop();
  });

  it('is not stale when it has never succeeded', async () => {
    const h = harness();
    h.setResult(async () => {
      throw new LimitsError('network', 'boom');
    });
    h.poller.start();
    await flush();
    expect(h.poller.snapshot()).toMatchObject({ stale: false, fetchedAt: null });
    expect(h.poller.snapshot().error?.code).toBe('network');
    h.poller.stop();
  });

  it('surfaces missing credentials as no_credentials', async () => {
    const h = harness();
    h.setToken(async () => {
      throw new NoCredentialsError('no keychain item');
    });
    h.poller.start();
    await flush();
    expect(h.poller.snapshot().error?.code).toBe('no_credentials');
    expect(h.calls).toHaveLength(0);
    h.poller.stop();
  });

  it('surfaces schema drift while keeping the last good limits', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.setResult(async () => {
      throw new LimitsError('schema_drift', 'no limits array');
    });
    await h.timers.advance(INTERVAL);
    expect(h.poller.snapshot().error?.code).toBe('schema_drift');
    expect(h.poller.snapshot().limits).toHaveLength(3);
    h.poller.stop();
  });
});

describe('LimitsPoller 401 handling', () => {
  it('re-reads credentials once and retries', async () => {
    const h = harness();
    let seen = 0;
    h.setToken(async () => (seen === 0 ? 'stale-token' : 'fresh-token'));
    h.setResult(async (token) => {
      seen += 1;
      if (token === 'stale-token') throw unauthorized();
      return liveLimitsFixture();
    });
    h.poller.start();
    await flush();
    expect(h.calls).toEqual(['stale-token', 'fresh-token']);
    expect(h.tokenReads).toEqual([{ fresh: false }, { fresh: true }]);
    expect(h.poller.snapshot().error).toBeNull();
    expect(h.timers.nextDelay).toBe(INTERVAL);
    h.poller.stop();
  });

  it('backs off straight to 10 minutes when still 401 after the retry', async () => {
    const h = harness();
    h.setResult(async () => {
      throw unauthorized();
    });
    h.poller.start();
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.poller.snapshot().error?.code).toBe('unauthorized');
    expect(h.timers.nextDelay).toBe(MAX_BACKOFF_MS);

    await h.timers.advance(MAX_BACKOFF_MS);
    expect(h.timers.nextDelay).toBe(MAX_BACKOFF_MS);
    h.poller.stop();
  });

  it('leaves the parked state once a fetch succeeds', async () => {
    const h = harness();
    let fail = true;
    h.setResult(async () => {
      if (fail) throw unauthorized();
      return liveLimitsFixture();
    });
    h.poller.start();
    await flush();
    expect(h.timers.nextDelay).toBe(MAX_BACKOFF_MS);
    fail = false;
    await h.timers.advance(MAX_BACKOFF_MS);
    expect(h.timers.nextDelay).toBe(INTERVAL);
    expect(h.poller.snapshot().error).toBeNull();
    h.poller.stop();
  });

  it('does not retry twice when the fresh read also fails to produce a token', async () => {
    const h = harness();
    let n = 0;
    h.setToken(async () => {
      n += 1;
      if (n > 1) throw new NoCredentialsError('gone');
      return 'tok';
    });
    h.setResult(async () => {
      throw unauthorized();
    });
    h.poller.start();
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.poller.snapshot().error?.code).toBe('no_credentials');
    h.poller.stop();
  });
});

describe('LimitsPoller refresh', () => {
  it('forces a fetch and reschedules', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    expect(h.calls).toHaveLength(1);
    const res = await h.poller.refresh();
    expect(res.rateLimited).toBe(false);
    expect(h.calls).toHaveLength(2);
    expect(h.timers.nextDelay).toBe(INTERVAL);
    h.poller.stop();
  });

  it('rate-limits to one per 10 s', async () => {
    const h = harness();
    const first = await h.poller.refresh();
    expect(first.rateLimited).toBe(false);
    const second = await h.poller.refresh();
    expect(second.rateLimited).toBe(true);
    expect(h.calls).toHaveLength(1);

    h.timers.clock += 9_999;
    expect((await h.poller.refresh()).rateLimited).toBe(true);
    h.timers.clock += 1;
    expect((await h.poller.refresh()).rateLimited).toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  it('returns the current snapshot even when rate-limited', async () => {
    const h = harness();
    await h.poller.refresh();
    const res = await h.poller.refresh();
    expect(res.snapshot.limits).toHaveLength(3);
  });

  it('works without start() and does not schedule when not running', async () => {
    const h = harness();
    await h.poller.refresh();
    expect(h.timers.pendingCount).toBe(0);
  });
});

describe('LimitsPoller.onChange (§19)', () => {
  /** The fixture with one percent moved, so the normalized body genuinely differs. */
  function moved(percent: number): Record<string, unknown> {
    const raw = liveLimitsFixture() as unknown as Record<string, unknown>;
    const five = raw['five_hour'] as Record<string, unknown>;
    return { ...raw, five_hour: { ...five, utilization: percent } };
  }

  it('fires on the first successful poll and not on an identical one', async () => {
    const h = harness();
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });

    await h.poller.refresh();
    expect(fired).toBe(1);

    h.timers.clock += 10_000;
    await h.poller.refresh();
    expect(h.calls).toHaveLength(2);
    expect(fired).toBe(1);
  });

  it('fires when the normalized body changes', async () => {
    const h = harness();
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });
    await h.poller.refresh();

    h.setResult(async () => moved(77));
    h.timers.clock += 10_000;
    await h.poller.refresh();
    expect(fired).toBe(2);
  });

  it('ignores a changed fetchedAt on its own', async () => {
    const h = harness();
    await h.poller.refresh();
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });
    h.timers.clock += 60_000;
    await h.poller.refresh();
    expect(h.poller.snapshot().fetchedAt).toMatch(/Z$/);
    expect(fired).toBe(0);
  });

  it('fires once when a poll starts failing, not on every repeat', async () => {
    const h = harness();
    await h.poller.refresh();
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });

    h.setResult(async () => {
      throw new LimitsError('network', 'boom');
    });
    h.timers.clock += 10_000;
    await h.poller.refresh();
    expect(h.poller.snapshot()).toMatchObject({ stale: true, error: { code: 'network' } });
    expect(fired).toBe(1);

    h.timers.clock += 10_000;
    await h.poller.refresh();
    expect(fired).toBe(1);

    // Recovery is news again.
    h.setResult(async () => liveLimitsFixture());
    h.timers.clock += 10_000;
    await h.poller.refresh();
    expect(fired).toBe(2);
  });

  it('stops delivering after unsubscribe, and survives a throwing listener', async () => {
    const h = harness();
    const seen: string[] = [];
    const off = h.poller.onChange(() => seen.push('a'));
    h.poller.onChange(() => {
      seen.push('b');
      throw new Error('listener blew up');
    });
    h.poller.onChange(() => seen.push('c'));

    await h.poller.refresh();
    expect(seen).toEqual(['a', 'b', 'c']);

    off();
    h.setResult(async () => moved(31));
    h.timers.clock += 10_000;
    await h.poller.refresh();
    expect(seen).toEqual(['a', 'b', 'c', 'b', 'c']);
  });
});
