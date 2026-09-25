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
import { healthBody, limitsBody, summaryBody, type SnapshotDeps, type UpdateStateProvider } from './snapshot.js';
import { zeroTotals, type TokensSource } from './types.js';
import type { SessionsSubsystem } from '../sessions/index.js';

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
  // --- W3: sessions & pause (§17, §18) ------------------------------------
  /** Sessions/pause subsystem; when absent those routes simply 404. */
  sessions?: SessionsSubsystem | null;
  // ------------------------------------------------------------------------
  /** W8: live auto-update state for `/health.update` and the SSE snapshot (§15, §20). */
  update?: UpdateStateProvider;
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
  /** The first bound listener, or `null` before `listen`. */
  readonly http: Server | null;
  /** One `http.Server` per bound address, all sharing `handle` (§16). */
  readonly servers: readonly Server[];
  readonly addresses: readonly BoundAddress[];
  /** The port every listener shares, or `null` before `listen`. */
  readonly port: number | null;
  /** The bus `GET /v1/events` streams; the daemon publishes onto it (§19). */
  readonly bus: EventBus;
  readonly events: EventsEndpoint;
  /** Attach the tokens source once it exists (daemon startup order, §6). */
  setTokensSource(source: TokensSource | null): void;
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Listen on one address or several and resolve with the bound port (tests pass 0). */
  listen(port: number, hosts?: string | readonly string[]): Promise<number>;
  /** Add one address after startup (SIGHUP re-resolution, §16); already bound → no-op. */
  bind(host: string, port?: number): Promise<number>;
  /** Stop listening on one address, leaving the rest up. */
  unbind(host: string): Promise<void>;
  /** Replace the extra Host names — the MagicDNS name, re-resolved on SIGHUP (§16). */
  setExtraHostNames(names: readonly string[]): void;
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
  // W3: one registration block — the routes themselves live in src/sessions/routes.ts.
  const sessionsRouter = opts.sessions?.router ?? null;
  /** One listener per requested address, keyed by the lower-cased host we asked for. */
  const listeners = new Map<string, { server: Server; addresses: BoundAddress[] }>();
  const bound: BoundAddress[] = [];
  let extraHostNames: string[] = [...(opts.extraHostNames ?? [])];
  let policy: HostPolicy = buildHostPolicy(bound, extraHostNames);
  let listenPort: number | null = null;

  /** `addresses` is handed out live, so it is refilled in place rather than replaced. */
  const rebuildPolicy = (): void => {
    bound.length = 0;
    for (const entry of listeners.values()) bound.push(...entry.addresses);
    policy = buildHostPolicy(bound, extraHostNames);
  };

  // --- route handlers -------------------------------------------------------

  // The `/health`, `/v1/limits` and `/v1/summary` bodies live in `./snapshot.js` so the
  // SSE `snapshot` event (§19) can embed exactly the same shapes.
  const snapshotDeps: SnapshotDeps = {
    config: opts.config,
    limits: opts.limits,
    tokens: () => tokens,
    user: readUser,
    ...(opts.update === undefined ? {} : { update: opts.update }),
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
      sendError(res, 429, 'rate_limited', 'limits were fetched from Anthropic under a minute ago — refresh is limited to once a minute', 'use GET /v1/limits for the current numbers');
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

    // W3: sessions & pause (§18.4) own their own method handling and status codes.
    if (sessionsRouter !== null && (await sessionsRouter.handle(req, res, method, path, url))) return;

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

  // --- listeners ------------------------------------------------------------

  /**
   * §16: one `http.Server` per address, all running the same `handle`. Binding is
   * per-address so the daemon can add a tailnet address that only appeared later, or drop
   * one that went away, without disturbing loopback.
   */
  async function bindOne(host: string, port: number): Promise<number> {
    const key = host.toLowerCase();
    const existing = listeners.get(key);
    if (existing !== undefined) return existing.addresses[0]?.port ?? port;

    const server = createHttpServer(handle);
    server.requestTimeout = requestTimeoutMs;
    server.headersTimeout = requestTimeoutMs;

    const actual = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        // A listener that never bound must not linger as a half-open handle.
        server.close();
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        const info = server.address() as AddressInfo | null;
        resolve(info === null ? port : info.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

    const info = server.address() as AddressInfo | null;
    const addresses: BoundAddress[] = [{ address: host, port: actual }];
    if (info !== null && info.address !== host) addresses.push({ address: info.address, port: actual });
    listeners.set(key, { server, addresses });
    listenPort = actual;
    rebuildPolicy();
    return actual;
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  return {
    get http() {
      return [...listeners.values()][0]?.server ?? null;
    },
    get servers() {
      return [...listeners.values()].map((entry) => entry.server);
    },
    get port() {
      return listenPort;
    },
    bus,
    events,
    get addresses() {
      return bound;
    },
    setTokensSource(source) {
      tokens = source;
      opts.sessions?.setTokensSource(source);
    },
    handle,
    async listen(port, hosts = '127.0.0.1') {
      const list = typeof hosts === 'string' ? [hosts] : [...hosts];
      if (list.length === 0) list.push('127.0.0.1');
      let actual = port;
      for (const host of list) {
        // Only the first bind may be told port 0; the rest must land on the same port.
        actual = await bindOne(host, actual);
      }
      return actual;
    },
    async bind(host, port) {
      const target = port ?? listenPort;
      if (target === null) throw new Error('bind() needs a port until listen() has run');
      return bindOne(host, target);
    },
    async unbind(host) {
      const key = host.toLowerCase();
      const entry = listeners.get(key);
      if (entry === undefined) return;
      listeners.delete(key);
      rebuildPolicy();
      await closeServer(entry.server);
    },
    setExtraHostNames(names) {
      extraHostNames = [...names];
      rebuildPolicy();
    },
    async close() {
      events.close();
      const entries = [...listeners.values()];
      listeners.clear();
      rebuildPolicy();
      await Promise.all(entries.map((entry) => closeServer(entry.server)));
    },
  };
}
