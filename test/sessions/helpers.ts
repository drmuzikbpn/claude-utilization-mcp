// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/bus.js';
import { isClaudeCodeCommand, type FreezeDeps, type ProcEntry, type ProcIdentity } from '../../src/pause/freeze.js';
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
  /** `/rename` titles by sessionId (§23.14). */
  titles = new Map<string, string>();

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

  sessionTitle(sessionId: string): string | null {
    return this.titles.get(sessionId) ?? null;
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

/**
 * Freeze deps over a synthetic process table; records every signal instead of sending it.
 *
 * Every pid in `table` is one of ours, started at `start-<pid>` and running `claude`,
 * unless the options say otherwise: `uids` reassigns or removes (`null`) a pid, `starts`
 * overrides a start time, `commands` a command line.
 */
export function fakeFreezeDeps(
  table: ProcEntry[],
  opts: {
    uid?: number;
    uids?: Record<number, number | null>;
    signals?: RecordedSignal[];
    starts?: Record<number, string>;
    commands?: Record<number, string>;
    selfPid?: number;
    bootId?: () => string | null;
  } = {},
): FreezeDeps & { signals: RecordedSignal[] } {
  const signals = opts.signals ?? [];
  const selfUid = opts.uid ?? 501;
  const uidOf = (pid: number): number | null => {
    if (opts.uids !== undefined && pid in opts.uids) return opts.uids[pid] ?? null;
    return table.some((e) => e.pid === pid) ? selfUid : null;
  };
  return {
    signals,
    listProcesses: () => table,
    inspect: (pids) => {
      const out = new Map<number, ProcIdentity>();
      for (const pid of pids) {
        const uid = uidOf(pid);
        if (uid === null) continue;
        out.set(pid, { pid, uid, start: opts.starts?.[pid] ?? `start-${String(pid)}`, command: opts.commands?.[pid] ?? 'claude' });
      }
      return out;
    },
    selfUid: () => selfUid,
    selfPid: () => opts.selfPid ?? 999_999,
    bootId: opts.bootId ?? (() => 'boot-1'),
    isSessionProcess: (identity) => isClaudeCodeCommand(identity.command),
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

export interface HarnessOptions {
  configDir?: string;
  table?: ProcEntry[];
  uids?: Record<number, number | null>;
  /** Mutable on purpose: a test changes an entry to simulate a recycled pid. */
  starts?: Record<number, string>;
  commands?: Record<number, string>;
  selfPid?: number;
  bootId?: () => string | null;
  maxSessions?: number;
  transcriptRoots?: readonly string[];
}

export function makeHarness(over: HarnessOptions = {}): Harness {
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
    freezeDeps: fakeFreezeDeps(over.table ?? [], {
      signals,
      ...(over.uids === undefined ? {} : { uids: over.uids }),
      ...(over.starts === undefined ? {} : { starts: over.starts }),
      ...(over.commands === undefined ? {} : { commands: over.commands }),
      ...(over.selfPid === undefined ? {} : { selfPid: over.selfPid }),
      ...(over.bootId === undefined ? {} : { bootId: over.bootId }),
    }),
    ...(over.maxSessions === undefined ? {} : { maxSessions: over.maxSessions }),
    ...(over.transcriptRoots === undefined ? {} : { transcriptRoots: over.transcriptRoots }),
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
