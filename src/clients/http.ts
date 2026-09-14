import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfigDir } from '../config.js';

export const DAEMON_FILE = 'daemon.json';

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

/**
 * Thrown when the daemon cannot be found or reached. Every client treats it as "no
 * information".
 *
 * `status` is the HTTP status when the daemon **answered** and the answer was an error, and
 * `undefined` when there was nothing to answer — no `daemon.json`, connection refused, a
 * timeout. Callers that must tell "the daemon says no" apart from "there is no daemon" read
 * this; everyone else keeps treating both the same (§23.23).
 */
export class DaemonUnreachable extends Error {
  readonly code = 'daemon_unreachable';
  readonly status: number | undefined;
  constructor(message: string, cause?: unknown, status?: number) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DaemonUnreachable';
    this.status = status;
  }
}

export function daemonFilePath(configDir: string = resolveConfigDir()): string {
  return join(configDir, DAEMON_FILE);
}

/** Read `<configDir>/daemon.json`; `null` when missing or unusable. Never throws. */
export function readDaemonInfo(configDir: string = resolveConfigDir()): DaemonInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(daemonFilePath(configDir), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const port = rec['port'];
  const pid = rec['pid'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return null;
  return {
    pid: typeof pid === 'number' ? pid : 0,
    port,
    startedAt: typeof rec['startedAt'] === 'string' ? rec['startedAt'] : '',
    version: typeof rec['version'] === 'string' ? rec['version'] : '',
  };
}

/** Is the pid in `daemon.json` still alive? A `false` here means the file is stale. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type ClientFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface DaemonClientOptions {
  configDir?: string;
  /** Skips `daemon.json` discovery (tests, and callers that already know the port). */
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClientFetch;
}

export const DEFAULT_CLIENT_TIMEOUT_MS = 2_000;

/** Thin HTTP client for the local daemon; discovers the port from `daemon.json`. */
export class DaemonClient {
  readonly timeoutMs: number;
  private readonly configDir: string;
  private readonly explicitBase: string | undefined;
  private readonly token: string | undefined;
  private readonly fetchImpl: ClientFetch;

  constructor(opts: DaemonClientOptions = {}) {
    this.configDir = opts.configDir ?? resolveConfigDir();
    this.explicitBase = opts.baseUrl;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as ClientFetch);
  }

  /** `http://127.0.0.1:<port>`; throws `DaemonUnreachable` when there is no daemon.json. */
  baseUrl(): string {
    if (this.explicitBase !== undefined) return this.explicitBase.replace(/\/$/, '');
    const info = readDaemonInfo(this.configDir);
    if (info === null) {
      throw new DaemonUnreachable('claude-usage daemon not running — run `claude-usage status`');
    }
    return `http://127.0.0.1:${info.port}`;
  }

  async get(path: string, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.request('GET', path, undefined, opts);
  }

  async post(path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.request('POST', path, body, opts);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    opts: { timeoutMs?: number },
  ): Promise<unknown> {
    const url = `${this.baseUrl()}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token !== undefined && this.token.length > 0) headers['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let res: FetchResponseLike;
    try {
      const init: Parameters<ClientFetch>[1] = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new DaemonUnreachable(`${method} ${path} failed: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const envelope = parsed as { error?: { code?: string; message?: string } } | null;
      const message = envelope?.error?.message ?? `HTTP ${res.status}`;
      throw new DaemonUnreachable(`${method} ${path}: ${message}`, parsed, res.status);
    }
    return parsed;
  }
}
