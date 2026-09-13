import { defaultConfig, type Config } from '../../src/config.js';
import { normalizeLimits } from '../../src/limits/normalize.js';
import { emptySnapshot, type LimitsSnapshot } from '../../src/limits/types.js';
import type { LimitsProvider } from '../../src/server/index.js';
import {
  zeroTotals,
  type ScanStats,
  type TokenTotals,
  type TokensQuery,
  type TokensResponse,
  type TokensSource,
} from '../../src/server/types.js';
import { liveLimitsFixture } from './fixtures.js';

export function fixtureSnapshot(over: Partial<LimitsSnapshot> = {}): LimitsSnapshot {
  const raw = liveLimitsFixture();
  return {
    fetchedAt: '2026-09-13T14:00:00.000Z',
    stale: false,
    error: null,
    ...normalizeLimits(raw),
    raw,
    ...over,
  };
}

/** Limits snapshot whose percents are overridden per limit id. */
export function snapshotWithPercents(percents: Record<string, number>, severity?: Record<string, string>): LimitsSnapshot {
  const base = fixtureSnapshot();
  return {
    ...base,
    limits: base.limits.map((l) => ({
      ...l,
      percent: percents[l.id] ?? l.percent,
      severity: severity?.[l.id] ?? l.severity,
    })),
  };
}

export class FakeLimitsProvider implements LimitsProvider {
  refreshCalls = 0;
  rateLimited = false;
  constructor(private current: LimitsSnapshot = fixtureSnapshot()) {}

  snapshot(): LimitsSnapshot {
    return this.current;
  }

  set(snapshot: LimitsSnapshot): void {
    this.current = snapshot;
  }

  async refresh(): Promise<{ rateLimited: boolean; snapshot: LimitsSnapshot }> {
    this.refreshCalls += 1;
    return { rateLimited: this.rateLimited, snapshot: this.current };
  }
}

export class EmptyLimitsProvider implements LimitsProvider {
  snapshot(): LimitsSnapshot {
    return emptySnapshot();
  }

  async refresh(): Promise<{ rateLimited: boolean; snapshot: LimitsSnapshot }> {
    return { rateLimited: false, snapshot: emptySnapshot() };
  }
}

export interface FakeTokensOptions {
  ready?: boolean;
  totals?: Partial<TokenTotals>;
  stats?: Partial<ScanStats>;
}

/** Stand-in for W1's SpendStore — the server is tested only against this contract. */
export class FakeTokensSource implements TokensSource {
  ready: boolean;
  stats: ScanStats;
  queries: TokensQuery[] = [];
  private readonly totals: TokenTotals;
  private readonly listeners = new Set<() => void>();

  constructor(opts: FakeTokensOptions = {}) {
    this.ready = opts.ready ?? true;
    this.totals = { ...zeroTotals(), ...opts.totals };
    this.stats = {
      filesTracked: 12,
      eventsIndexed: 5400,
      parseErrors: 0,
      lastScanAt: '2026-09-13T13:59:00.000Z',
      ...opts.stats,
    };
  }

  query(q: TokensQuery): TokensResponse {
    this.queries.push(q);
    return {
      ready: this.ready,
      stale: false,
      since: q.since,
      groupBy: q.groupBy,
      totals: this.totals,
      groups: this.ready
        ? [{ key: '-Users-me-code-foo', label: '/Users/me/code/foo', ...this.totals }]
        : [],
    };
  }

  sessionTotals(): TokenTotals | null {
    return this.ready ? this.totals : null;
  }

  sessionModel(): string | null {
    return 'claude-fable-5-1';
  }

  sessionStartedAt(): string | null {
    return '2026-09-13T12:00:00.000Z';
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(): void {
    for (const cb of this.listeners) cb();
  }
}

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...defaultConfig(), name: 'test-host', auth: { token: 'test-bearer-token' }, ...over };
}
