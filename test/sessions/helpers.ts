import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/bus.js';
import type { FreezeDeps, ProcEntry } from '../../src/pause/freeze.js';
import { createSessionsSubsystem, type SessionsSubsystem } from '../../src/sessions/index.js';
import { createServer, type UsageServer } from '../../src/server/index.js';
import {
  zeroTotals,
  type ScanStats,
  type TokensQuery,
  type TokensResponse,
  type TokensSource,
  type TokenTotals,
  type TranscriptSession,
} from '../../src/server/types.js';
import { FakeLimitsProvider, snapshotWithPercents, testConfig } from '../helpers/fakes.js';

export function tempDir(prefix = 'cu-sessions-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A `TokensSource` that only knows what W3 asks of it. */
export class StubTokens implements TokensSource {
  ready = true;
  stats: ScanStats = { filesTracked: 0, eventsIndexed: 0, parseErrors: 0, lastScanAt: null };
  sessions = new Map<string, { model: string; startedAt: string; totals: TokenTotals; projectKey: string; lastActivityAt: string; cwd: string }>();

  add(sessionId: string, over: Partial<{ model: string; startedAt: string; totals: TokenTotals; projectKey: string; lastActivityAt: string; cwd: string }> = {}): void {
    this.sessions.set(sessionId, {
      model: 'claude-fable-5-1',
      startedAt: '2026-09-13T10:00:00.000Z',
      totals: { ...zeroTotals(), input: 10, output: 5, messages: 2 },
      projectKey: '-tmp-x-foo',
      lastActivityAt: '2026-09-13T11:00:00.000Z',
      cwd: '/tmp/x/foo',
      ...over,
    });
  }

  query(q: TokensQuery): TokensResponse {
    return { ready: true, stale: false, since: q.since, groupBy: q.groupBy, totals: zeroTotals(), groups: [] };
  }

  listSessions(): TranscriptSession[] {
    return [...this.sessions].map(([sessionId, meta]) => ({
      sessionId,
      projectKey: meta.projectKey,
      lastActivityAt: meta.lastActivityAt,
      cwd: meta.cwd,
    }));
  }

  sessionTotals(sessionId: string): TokenTotals | null {
    return this.sessions.get(sessionId)?.totals ?? null;
  }

  sessionModel(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.model ?? null;
  }

  sessionStartedAt(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.startedAt ?? null;
  }

  onChange(): () => void {
    return () => {};
  }
}

export interface RecordedSignal {
  pid: number;
  signal: string;
}

/** Freeze deps over a synthetic process table; records every signal instead of sending it. */
export function fakeFreezeDeps(
  table: ProcEntry[],
  opts: { uid?: number; uids?: Record<number, number | null>; signals?: RecordedSignal[] } = {},
): FreezeDeps & { signals: RecordedSignal[] } {
  const signals = opts.signals ?? [];
  const selfUid = opts.uid ?? 501;
  return {
    signals,
    listProcesses: () => table,
    uidOf: (pid) => {
      if (opts.uids !== undefined && pid in opts.uids) return opts.uids[pid] ?? null;
      return table.some((e) => e.pid === pid) ? selfUid : null;
    },
    selfUid: () => selfUid,
    kill: (pid, signal) => {
      signals.push({ pid, signal });
    },
  };
}

export interface Harness {
  subsystem: SessionsSubsystem;
  configDir: string;
  bus: EventBus;
  tokens: StubTokens;
  clock: { now: number };
  alive: Set<number>;
  signals: RecordedSignal[];
}

export function makeHarness(over: { configDir?: string; table?: ProcEntry[]; uids?: Record<number, number | null> } = {}): Harness {
  const configDir = over.configDir ?? tempDir();
  const bus = new EventBus();
  const tokens = new StubTokens();
  const clock = { now: Date.parse('2026-09-13T12:00:00.000Z') };
  const alive = new Set<number>();
  const signals: RecordedSignal[] = [];
  const subsystem = createSessionsSubsystem({
    configDir,
    bus,
    tokens,
    now: () => clock.now,
    isAlive: (pid) => alive.has(pid),
    freezeDeps: fakeFreezeDeps(over.table ?? [], { signals, ...(over.uids === undefined ? {} : { uids: over.uids }) }),
  });
  return { subsystem, configDir, bus, tokens, clock, alive, signals };
}

export async function startHarnessServer(h: Harness): Promise<{ server: UsageServer; port: number }> {
  const server = createServer({
    config: testConfig(),
    // Over the warn threshold so the §7.1 nudge has something to print.
    limits: new FakeLimitsProvider(snapshotWithPercents({ session: 84, weekly_all: 61 })),
    tokens: h.tokens,
    version: '9.9.9',
    bus: h.bus,
    sessions: h.subsystem,
  });
  const port = await server.listen(0, '127.0.0.1');
  return { server, port };
}

export const TOKEN = 'test-bearer-token';
