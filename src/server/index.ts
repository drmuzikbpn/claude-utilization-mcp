import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redactConfig, type Config } from '../config.js';
import { computeStatus } from '../limits/status.js';
import { stripRaw, type LimitsSnapshot } from '../limits/types.js';
import { getVersion } from '../version.js';
import { sendError, sendJson } from './errors.js';
import { createUserReader, defaultClaudeJsonPath, type OauthAccount } from './identity.js';
import { buildHostPolicy, checkRequest, type HostPolicy } from './middleware.js';
import { parseTokensQuery } from './query.js';
import { emptyScanStats, zeroTotals, type TokensSource } from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './middleware.js';
export * from './query.js';
export * from './identity.js';

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
}

export interface BoundAddress {
  address: string;
  port: number;
}

export interface UsageServer {
  readonly http: Server;
  readonly addresses: readonly BoundAddress[];
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

  function healthBody(): Record<string, unknown> {
    const stats = tokens?.stats ?? emptyScanStats();
    const user: OauthAccount | null = readUser();
    return {
      ok: true,
      name: opts.config.name,
      version,
      uptimeMs: Math.max(0, now() - startedAt),
      pid: process.pid,
      user,
      // W8 owns auto-update; until then the daemon reports it as disabled.
      update: {
        channel: 'stable',
        current: version,
        available: null,
        state: 'disabled',
        deferredReason: null,
      },
      stats: {
        filesTracked: stats.filesTracked,
        eventsIndexed: stats.eventsIndexed,
        parseErrors: stats.parseErrors,
        lastScanAt: stats.lastScanAt,
        spendReady: tokens?.ready ?? false,
        ...(stats.scan === undefined ? {} : { scan: stats.scan }),
      },
    };
  }

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

  function summaryBody(): Record<string, unknown> {
    const snapshot = opts.limits.snapshot();
    const status = computeStatus(snapshot.limits, opts.config.thresholds);
    const ready = tokens?.ready ?? false;
    const today = ready && tokens !== null
      ? tokens.query({ since: new Date(new Date(now()).setHours(0, 0, 0, 0)).toISOString(), groupBy: 'day' }).totals
      : zeroTotals();
    return {
      // `/v1/limits` minus `raw` (§4); the array itself is §23.3's shape.
      limits: stripRaw(snapshot),
      status,
      thresholds: opts.config.thresholds,
      today: { ready, ...today },
    };
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
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        sendError(res, 500, 'internal_error', 'request timed out');
        res.destroy();
      }
    }, requestTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    res.on('close', () => {
      clearTimeout(timer);
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
        sendJson(res, 200, healthBody());
        return;
      case '/v1/limits':
        sendJson(res, 200, opts.limits.snapshot());
        return;
      case '/v1/summary':
        sendJson(res, 200, summaryBody());
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
      default:
        sendError(res, 404, 'not_found', `no route for ${path}`);
    }
  }

  const http = createHttpServer(handle);
  http.requestTimeout = requestTimeoutMs;
  http.headersTimeout = requestTimeoutMs;

  return {
    http,
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
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      });
    },
  };
}
