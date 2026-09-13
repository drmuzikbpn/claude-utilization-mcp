import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redactConfig, type Config } from '../config.js';
import { EventBus } from '../events/bus.js';
import type { LimitsSnapshot } from '../limits/types.js';
import { getVersion } from '../version.js';
import {
  createEventsEndpoint,
  EVENTS_PATH,
  isEventsRequest,
  type EventsEndpoint,
  type EventsTuning,
  type SnapshotProvider,
} from './events.js';
import { sendError, sendJson } from './errors.js';
import { createUserReader, defaultClaudeJsonPath } from './identity.js';
import { buildHostPolicy, checkRequest, type HostPolicy } from './middleware.js';
import { parseTokensQuery } from './query.js';
import { healthBody, limitsBody, summaryBody, type SnapshotDeps } from './snapshot.js';
import { zeroTotals, type TokensSource } from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './middleware.js';
export * from './query.js';
export * from './identity.js';
export * from './snapshot.js';
export * from './events.js';

/** 5 s request timeout (§4). */
export const REQUEST_TIMEOUT_MS = 5_000;

/** What the server needs from the limits poller. */
export interface LimitsProvider {
  snapshot(): LimitsSnapshot;
  refresh(): Promise<{ rateLimited: boolean; snapshot: LimitsSnapshot }>;
}

export interface ServerOptions {
  config: Config;
  limits: LimitsProvider;
  /** `null` until W1's SpendStore is wired in; `/v1/tokens` then answers `ready: false`. */
  tokens?: TokensSource | null;
  version?: string;
  startedAt?: number;
  /** Extra Host names to allow (e.g. the MagicDNS name — §16). */
  extraHostNames?: readonly string[];
  claudeJsonPath?: string;
  now?: () => number;
  requestTimeoutMs?: number;
  /** Shared event bus for `GET /v1/events`; one is created when omitted (§19). */
  bus?: EventBus;
  /** Sessions and pause rules for the SSE `snapshot` event; defaults to empty arrays. */
  snapshots?: SnapshotProvider | undefined;
  eventsTuning?: EventsTuning;
}

export interface BoundAddress {
  address: string;
  port: number;
}

export interface UsageServer {
  readonly http: Server;
  readonly addresses: readonly BoundAddress[];
  /** The bus `GET /v1/events` streams; the daemon publishes onto it (§19). */
  readonly bus: EventBus;
  readonly events: EventsEndpoint;
  /** Attach the tokens source once it exists (daemon startup order, §6). */
  setTokensSource(source: TokensSource | null): void;
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Listen and resolve with the bound port (tests pass 0). */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

interface RouteKey {
  method: string;
  path: string;
}

const ROUTES: readonly RouteKey[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/v1/limits' },
  { method: 'GET', path: '/v1/summary' },
  { method: 'GET', path: '/v1/tokens' },
  { method: 'POST', path: '/v1/refresh' },
  { method: 'GET', path: '/v1/config' },
  { method: 'GET', path: EVENTS_PATH },
];

function allowedMethodsFor(path: string): string[] {
  const methods = ROUTES.filter((r) => r.path === path).map((r) => r.method);
  if (methods.includes('GET') && !methods.includes('HEAD')) methods.push('HEAD');
  return methods;
}

export function createServer(opts: ServerOptions): UsageServer {
  const now = opts.now ?? Date.now;
  const version = opts.version ?? getVersion();
  const startedAt = opts.startedAt ?? now();
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const readUser = createUserReader(opts.claudeJsonPath ?? defaultClaudeJsonPath(), now);

  let tokens: TokensSource | null = opts.tokens ?? null;
  const bound: BoundAddress[] = [];
  let policy: HostPolicy = buildHostPolicy(bound, opts.extraHostNames ?? []);

  const rebuildPolicy = (): void => {
    policy = buildHostPolicy(bound, opts.extraHostNames ?? []);
  };

  // --- route handlers -------------------------------------------------------

  // The `/health`, `/v1/limits` and `/v1/summary` bodies live in `./snapshot.js` so the
  // SSE `snapshot` event (§19) can embed exactly the same shapes.
  const snapshotDeps: SnapshotDeps = {
    config: opts.config,
    limits: opts.limits,
    tokens: () => tokens,
    user: readUser,
    version,
    startedAt,
    now,
  };

  const bus = opts.bus ?? new EventBus();
  const events = createEventsEndpoint({
    bus,
    deps: snapshotDeps,
    provider: opts.snapshots,
    maxClients: opts.config.events.maxClients,
    ...(opts.eventsTuning ?? {}),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });

  function tokensBody(url: URL, res: ServerResponse): void {
    const parsed = parseTokensQuery(url.searchParams, now());
    if (!parsed.ok) {
      sendError(
        res,
        400,
        'bad_request',
        `invalid "${parsed.param}" parameter`,
        parsed.param === 'groupBy'
          ? 'groupBy must be one of project, session, model, day'
          : 'since must be an ISO-8601 instant, today, all, or a relative value such as 7d or 24h',
      );
      return;
    }
    const { query } = parsed;
    if (tokens === null) {
      sendJson(res, 200, {
        ready: false,
        stale: false,
        since: query.since,
        groupBy: query.groupBy,
        totals: zeroTotals(),
        groups: [],
      });
      return;
    }
    sendJson(res, 200, tokens.query(query));
  }

  async function refresh(res: ServerResponse): Promise<void> {
    const result = await opts.limits.refresh();
    if (result.rateLimited) {
      sendError(res, 429, 'rate_limited', 'limits refresh is rate-limited to one per 10 s', 'retry shortly');
      return;
    }
    sendJson(res, 200, result.snapshot);
  }

  // --- request pipeline -----------------------------------------------------

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // SSE streams are long-lived by design — they must not hit the request timeout (§19).
    const timer = isEventsRequest(req)
      ? null
      : setTimeout(() => {
          if (!res.writableEnded) {
            sendError(res, 500, 'internal_error', 'request timed out');
            res.destroy();
          }
        }, requestTimeoutMs);
    if (timer !== null && typeof timer.unref === 'function') timer.unref();
    res.on('close', () => {
      if (timer !== null) clearTimeout(timer);
    });

    void dispatch(req, res).catch((err: unknown) => {
      if (!res.writableEnded) {
        sendError(res, 500, 'internal_error', err instanceof Error ? err.message : 'unhandled error');
      }
    });
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = checkRequest(req, policy, opts.config.auth.token);
    if (!gate.ok) {
      sendError(res, gate.status, gate.code, gate.message, gate.hint);
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;

    const known = ROUTES.some((r) => r.path === path);
    if (!known) {
      sendError(res, 404, 'not_found', `no route for ${path}`);
      return;
    }
    const allowed = allowedMethodsFor(path);
    if (!allowed.includes(method)) {
      res.setHeader('allow', allowed.join(', '));
      sendError(res, 405, 'method_not_allowed', `${method} is not allowed on ${path}`, `allowed: ${allowed.join(', ')}`);
      return;
    }

    switch (path) {
      case '/health':
        sendJson(res, 200, healthBody(snapshotDeps));
        return;
      case '/v1/limits':
        sendJson(res, 200, limitsBody(snapshotDeps));
        return;
      case '/v1/summary':
        sendJson(res, 200, summaryBody(snapshotDeps));
        return;
      case '/v1/tokens':
        tokensBody(url, res);
        return;
      case '/v1/refresh':
        await refresh(res);
        return;
      case '/v1/config':
        sendJson(res, 200, redactConfig(opts.config));
        return;
      case EVENTS_PATH:
        events.handle(req, res);
        return;
      default:
        sendError(res, 404, 'not_found', `no route for ${path}`);
    }
  }

  const http = createHttpServer(handle);
  http.requestTimeout = requestTimeoutMs;
  http.headersTimeout = requestTimeoutMs;

  return {
    http,
    bus,
    events,
    get addresses() {
      return bound;
    },
    setTokensSource(source) {
      tokens = source;
    },
    handle,
    listen(port, host = '127.0.0.1') {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => {
          http.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          http.removeListener('error', onError);
          const info = http.address() as AddressInfo | null;
          const actual = info === null ? port : info.port;
          bound.push({ address: host, port: actual });
          if (info !== null && info.address !== host) bound.push({ address: info.address, port: actual });
          rebuildPolicy();
          resolve(actual);
        };
        http.once('error', onError);
        http.once('listening', onListening);
        http.listen(port, host);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        events.close();
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      });
    },
  };
}
