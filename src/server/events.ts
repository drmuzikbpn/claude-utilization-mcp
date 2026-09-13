/**
 * `GET /v1/events` — the SSE stream (§19).
 *
 * Wire format, one frame per event, `\n\n`-terminated:
 *
 * ```text
 * retry: 3000
 *
 * id: <bus rev at send time>
 * event: snapshot|limits|spend|session|pause|update|heartbeat
 * data: <one line of JSON>
 * ```
 *
 * Every connect — with or without `Last-Event-ID`, which we deliberately ignore — starts
 * with one `snapshot` carrying the same bodies as `/health`, `/v1/limits` and
 * `/v1/summary` (built by `./snapshot.js`, never re-derived here). After that the stream
 * forwards the shared `EventBus`, coalesces `spend` to at most one event per second and
 * heartbeats every 15 s. Slow clients are dropped so one stalled phone cannot pin the
 * daemon's memory; they reconnect and get a fresh snapshot.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BusEvents, EventBus } from '../events/bus.js';
import type { LimitsSnapshot, LimitsSnapshotLite } from '../limits/types.js';
import { sendError } from './errors.js';
import { limitsLiteBody, summaryBody, todayBody, updateBody, type SnapshotDeps } from './snapshot.js';
import type { TokenTotals, TokensSource } from './types.js';

export const EVENTS_PATH = '/v1/events';
/** `retry:` hint sent on connect — how long a client waits before reconnecting (§19). */
export const RETRY_MS = 3_000;
export const HEARTBEAT_MS = 15_000;
/** A client backed up for longer than this is destroyed (§19). */
export const SLOW_CLIENT_MS = 30_000;
/** `spend` is emitted at most once per this window (§19). */
export const SPEND_COALESCE_MS = 1_000;
/** How often back-pressure is re-checked. */
export const SWEEP_MS = 1_000;
export const DEFAULT_MAX_CLIENTS = 16;

/** Sessions and pause rules for the `snapshot` event; W3 owns the real implementation. */
export interface SnapshotProvider {
  sessions(): unknown[];
  rules(): unknown[];
}

export const EMPTY_SNAPSHOT_PROVIDER: SnapshotProvider = {
  sessions: () => [],
  rules: () => [],
};

/** Injectable timers so tests can drive heartbeat, coalescing and eviction. */
export interface EventTimers {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realEventTimers: EventTimers = {
  setInterval: (cb, ms) => {
    const t = setInterval(cb, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
  },
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Knobs the server passes through; all default to the constants above. */
export interface EventsTuning {
  maxClients?: number;
  heartbeatMs?: number;
  slowClientMs?: number;
  coalesceMs?: number;
  sweepMs?: number;
  retryMs?: number;
  timers?: EventTimers;
  now?: () => number;
}

export interface EventsOptions extends EventsTuning {
  bus: EventBus;
  deps: SnapshotDeps;
  provider?: SnapshotProvider | undefined;
}

export interface EventsEndpoint {
  /** Serve one `/v1/events` request; the gate has already passed. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  readonly clientCount: number;
  /** Drop every stream and stop the timers (daemon shutdown). */
  close(): void;
}

/** True for the SSE route, which must skip the 5 s per-request timeout. */
export function isEventsRequest(req: IncomingMessage): boolean {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  return path === EVENTS_PATH || path === `${EVENTS_PATH}/`;
}

function streamHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    // Usage data is never cached, and no proxy may buffer the stream.
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  };
}

function isNumericRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'number');
}

/**
 * Sum two `spend` deltas. Coalescing must not lose tokens: when five publishes collapse
 * into one event the client still sees the full burn. Non-numeric payloads (a future
 * delta shape) fall back to the newest value.
 */
export function mergeDeltas(older: unknown, newer: unknown): unknown {
  if (!isNumericRecord(older) || !isNumericRecord(newer)) return newer;
  const out: Record<string, number> = { ...older };
  for (const [key, value] of Object.entries(newer)) out[key] = (out[key] ?? 0) + value;
  return out;
}

interface Client {
  res: ServerResponse;
  /** When the socket first went unwritable, or `null` while it is keeping up. */
  backedUpSince: number | null;
  unsubscribes: Array<() => void>;
  /** Pending coalesced `spend`, flushed by `spendTimer`. */
  spend: { today: unknown; delta: unknown; rev: number } | null;
  spendTimer: unknown;
}

export function createEventsEndpoint(opts: EventsOptions): EventsEndpoint {
  const { bus, deps } = opts;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? realEventTimers;
  const provider = opts.provider ?? EMPTY_SNAPSHOT_PROVIDER;
  const maxClients = opts.maxClients ?? DEFAULT_MAX_CLIENTS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const slowClientMs = opts.slowClientMs ?? SLOW_CLIENT_MS;
  const coalesceMs = opts.coalesceMs ?? SPEND_COALESCE_MS;
  const sweepMs = opts.sweepMs ?? SWEEP_MS;
  const retryMs = opts.retryMs ?? RETRY_MS;

  const clients = new Set<Client>();
  let heartbeatHandle: unknown = null;
  let sweepHandle: unknown = null;

  function write(client: Client, text: string): void {
    const res = client.res;
    if (res.writableEnded || res.destroyed) return;
    const flushed = res.write(text);
    if (!flushed || res.writableLength > 0) {
      if (client.backedUpSince === null) client.backedUpSince = now();
    } else {
      client.backedUpSince = null;
    }
  }

  function send(client: Client, name: string, data: unknown, rev: number): void {
    write(client, `id: ${rev}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** `{ name, version, user, limits, summary, sessions, rules, update, rev }` (§19). */
  function snapshotPayload(): Record<string, unknown> {
    return {
      name: deps.config.name,
      version: deps.version,
      user: deps.user(),
      limits: limitsLiteBody(deps),
      summary: summaryBody(deps),
      sessions: provider.sessions(),
      rules: provider.rules(),
      update: updateBody(deps.version),
      rev: bus.rev,
    };
  }

  function flushSpend(client: Client): void {
    client.spendTimer = null;
    const pending = client.spend;
    client.spend = null;
    if (pending === null) return;
    send(client, 'spend', { today: pending.today, delta: pending.delta }, pending.rev);
  }

  function onSpend(client: Client, payload: BusEvents['spend'], rev: number): void {
    const pending = client.spend;
    client.spend = {
      // The newest reading wins for `today`; the delta accumulates what was coalesced away.
      today: payload.today,
      delta: pending === null ? payload.delta : mergeDeltas(pending.delta, payload.delta),
      rev,
    };
    if (client.spendTimer !== null) return;
    client.spendTimer = timers.setTimeout(() => {
      flushSpend(client);
    }, coalesceMs);
  }

  function startTimers(): void {
    if (heartbeatHandle === null) {
      heartbeatHandle = timers.setInterval(() => {
        const rev = bus.rev;
        const payload = { rev, at: new Date(now()).toISOString() };
        for (const client of clients) send(client, 'heartbeat', payload, rev);
      }, heartbeatMs);
    }
    if (sweepHandle === null) {
      sweepHandle = timers.setInterval(() => {
        evictSlowClients();
      }, sweepMs);
    }
  }

  function stopTimers(): void {
    if (heartbeatHandle !== null) {
      timers.clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
    if (sweepHandle !== null) {
      timers.clearInterval(sweepHandle);
      sweepHandle = null;
    }
  }

  function detach(client: Client): void {
    for (const off of client.unsubscribes) off();
    client.unsubscribes = [];
    if (client.spendTimer !== null) {
      timers.clearTimeout(client.spendTimer);
      client.spendTimer = null;
    }
    client.spend = null;
    clients.delete(client);
    if (clients.size === 0) stopTimers();
  }

  function evictSlowClients(): void {
    const t = now();
    for (const client of [...clients]) {
      const since = client.backedUpSince;
      if (since === null || t - since <= slowClientMs) continue;
      detach(client);
      client.res.destroy();
    }
  }

  function open(req: IncomingMessage, res: ServerResponse): void {
    // An SSE stream must outlive any socket inactivity timeout.
    const socket = req.socket as unknown as { setTimeout?: (ms: number) => void; setNoDelay?: (on: boolean) => void } | undefined;
    socket?.setTimeout?.(0);
    socket?.setNoDelay?.(true);

    res.writeHead(200, streamHeaders());
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const client: Client = { res, backedUpSince: null, unsubscribes: [], spend: null, spendTimer: null };
    clients.add(client);

    write(client, `retry: ${retryMs}\n\n`);
    send(client, 'snapshot', snapshotPayload(), bus.rev);

    client.unsubscribes.push(
      bus.subscribe('limits', (payload, rev) => send(client, 'limits', payload, rev)),
      bus.subscribe('session', (payload, rev) => send(client, 'session', payload, rev)),
      bus.subscribe('pause', (payload, rev) => send(client, 'pause', payload, rev)),
      bus.subscribe('update', (payload, rev) => send(client, 'update', payload, rev)),
      bus.subscribe('spend', (payload, rev) => onSpend(client, payload, rev)),
    );

    const close = (): void => detach(client);
    res.on('close', close);
    res.on('error', close);
    // A drained socket is caught up again, whatever the sweep last saw.
    res.on('drain', () => {
      client.backedUpSince = null;
    });

    startTimers();
  }

  return {
    handle(req, res) {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') {
        // Enough for a client to check the route and its headers; no stream, no client slot.
        res.writeHead(200, streamHeaders());
        res.end();
        return;
      }
      if (method !== 'GET') {
        res.setHeader('allow', 'GET, HEAD');
        sendError(res, 405, 'method_not_allowed', `${method} is not allowed on ${EVENTS_PATH}`, 'allowed: GET, HEAD');
        return;
      }
      if (clients.size >= maxClients) {
        sendError(
          res,
          503,
          'unavailable',
          `at most ${maxClients} concurrent event streams are served`,
          'close an open stream, or raise events.maxClients in config.json',
        );
        return;
      }
      open(req, res);
    },
    get clientCount() {
      return clients.size;
    },
    close() {
      for (const client of [...clients]) {
        detach(client);
        client.res.destroy();
      }
      stopTimers();
    },
  };
}

// --- daemon-side publishers -------------------------------------------------

const TOTAL_KEYS: ReadonlyArray<keyof TokenTotals> = ['input', 'output', 'cacheCreate', 'cacheRead', 'messages'];

function zeroTotalsRecord(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0 };
}

/** `b - a`, field by field; never negative-clamped — a rescan can legitimately shrink. */
export function diffTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  const out = zeroTotalsRecord();
  for (const key of TOTAL_KEYS) out[key] = b[key] - a[key];
  return out;
}

function isZero(totals: TokenTotals): boolean {
  return TOTAL_KEYS.every((key) => totals[key] === 0);
}

/** A cheap change signature for the limits snapshot — `raw` is deliberately excluded. */
export function limitsSignature(snapshot: LimitsSnapshotLite): string {
  return JSON.stringify([
    snapshot.fetchedAt,
    snapshot.stale,
    snapshot.error?.code ?? null,
    snapshot.limits.map((l) => [l.id, l.percent, l.severity, l.resetsAt, l.isActive]),
    snapshot.extraUsage,
  ]);
}

export interface PublisherOptions {
  bus: EventBus;
  limits: { snapshot(): LimitsSnapshot };
  /** Live getter: the token store is attached after the HTTP server starts (§6). */
  tokens(): TokensSource | null;
  now?: () => number;
  /** How often the limits snapshot is sampled for changes. */
  sampleMs?: number;
  /** `spend` is published at most once per this window (§19). */
  coalesceMs?: number;
  timers?: EventTimers;
}

/**
 * Wire the daemon's own sources onto the bus: `limits` whenever a poll changed anything,
 * and machine-wide `spend` whenever the token store changes (§19, §23.13).
 *
 * The poller has no change callback, so its snapshot is sampled — comparing a small
 * signature once a second is far cheaper than plumbing an observer through W2's poller.
 * Returns a stop function.
 */
export function startBusPublishers(opts: PublisherOptions): () => void {
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? realEventTimers;
  const sampleMs = opts.sampleMs ?? SWEEP_MS;
  const coalesceMs = opts.coalesceMs ?? SPEND_COALESCE_MS;

  const deps = { limits: opts.limits, tokens: opts.tokens, now };
  let lastSignature = limitsSignature(limitsLiteBody(deps));
  let lastTotals: TokenTotals | null = null;
  let spendTimer: unknown = null;
  let unsubscribeTokens: (() => void) | null = null;

  const publishSpend = (): void => {
    spendTimer = null;
    const today = todayBody(deps);
    const totals: TokenTotals = {
      input: today.input,
      output: today.output,
      cacheCreate: today.cacheCreate,
      cacheRead: today.cacheRead,
      messages: today.messages,
    };
    const delta = diffTotals(lastTotals ?? zeroTotalsRecord(), totals);
    lastTotals = totals;
    // A change that did not move today's totals (an older day's file) is not news.
    if (isZero(delta)) return;
    opts.bus.publish('spend', { today, delta });
  };

  const onTokensChanged = (): void => {
    // Trailing-edge coalescing: at most one `spend` per window, delta accumulated.
    if (spendTimer !== null) return;
    spendTimer = timers.setTimeout(publishSpend, coalesceMs);
  };

  const sample = (): void => {
    const lite = limitsLiteBody(deps);
    const signature = limitsSignature(lite);
    if (signature !== lastSignature) {
      lastSignature = signature;
      opts.bus.publish('limits', lite);
    }
    if (unsubscribeTokens === null) {
      const tokens = opts.tokens();
      if (tokens !== null) unsubscribeTokens = tokens.onChange(onTokensChanged);
    }
  };

  const tokens = opts.tokens();
  if (tokens !== null) unsubscribeTokens = tokens.onChange(onTokensChanged);
  const sampleHandle = timers.setInterval(sample, sampleMs);

  return () => {
    timers.clearInterval(sampleHandle);
    if (spendTimer !== null) {
      timers.clearTimeout(spendTimer);
      spendTimer = null;
    }
    unsubscribeTokens?.();
    unsubscribeTokens = null;
  };
}
