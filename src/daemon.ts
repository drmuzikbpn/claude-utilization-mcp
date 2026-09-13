import { rmSync } from 'node:fs';
import { createTokenReader } from './credentials/index.js';
import { LimitsPoller } from './limits/poller.js';
import { ensureConfigDir, expandHome, loadConfig, resolveConfigDir, writeJsonFile, type Config } from './config.js';
import { daemonFilePath } from './clients/http.js';
import { createServer, type UsageServer } from './server/index.js';
import type { TokensSource } from './server/types.js';
import { getVersion } from './version.js';

export interface DaemonOptions {
  configDir?: string;
  /** Pre-loaded config; otherwise read from `configDir`. */
  config?: Config;
  /**
   * The token store. Pass it explicitly (tests, and the orchestrator once W1 lands);
   * omit to let `createTokensSource` try the real `src/spend` module.
   */
  tokens?: TokensSource | null;
  createTokensSource?: (config: Config) => Promise<TokensSource | null>;
  verbose?: boolean;
  log?: (line: string) => void;
  version?: string;
  /** Start the limits poller (off in tests that do not want network timers). */
  poll?: boolean;
  port?: number;
}

export interface DaemonHandle {
  readonly port: number;
  readonly config: Config;
  readonly configDir: string;
  readonly server: UsageServer;
  readonly poller: LimitsPoller;
  stop(): Promise<void>;
}

/** Thrown when the configured port is already taken (§6 → exit 1). */
export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`port ${port} is already in use — another claude-usage daemon may be running`);
    this.name = 'PortInUseError';
    this.port = port;
  }
}

/**
 * Load `SpendStore` from W1's module if it is present. The dynamic specifier keeps
 * `tsc` happy while `src/spend/**` is owned by another branch; a missing module simply
 * means `/v1/tokens` answers `ready: false`.
 */
async function loadSpendStore(config: Config, log: (line: string) => void): Promise<TokensSource | null> {
  const specifier = './spend/index.js';
  try {
    const mod = (await import(specifier as string)) as { SpendStore?: new () => TokensSource & { start(dir: string): Promise<void> } };
    const Ctor = mod.SpendStore;
    if (typeof Ctor !== 'function') {
      log('spend: module present but exports no SpendStore — /v1/tokens will report ready:false');
      return null;
    }
    const store = new Ctor();
    // The store owns watcher-before-scan ordering (§23.7).
    await store.start(expandHome(config.projectsDir));
    return store;
  } catch (err) {
    log(`spend: store unavailable (${(err as Error).message}) — /v1/tokens will report ready:false`);
    return null;
  }
}

/**
 * Start the daemon (§6).
 *
 * Order: load config → start HTTP (so `/v1/limits` answers immediately) → start the
 * poller → attach the token store (its own watcher-before-scan ordering, §23.7).
 * Writes `daemon.json` 0600 once the port is known.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const configDir = opts.configDir ?? resolveConfigDir();
  const verbose = opts.verbose ?? false;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const debug = (line: string): void => {
    if (verbose) log(line);
  };
  const version = opts.version ?? getVersion();

  const config = opts.config ?? loadConfig(configDir);
  ensureConfigDir(configDir);
  debug(`config: loaded from ${configDir}`);

  const poller = new LimitsPoller({
    getToken: createTokenReader(),
    intervalMs: config.pollIntervalMs,
    log: debug,
  });

  const server = createServer({
    config,
    limits: poller,
    tokens: opts.tokens ?? null,
    version,
  });

  const port = opts.port ?? config.port;
  let bound: number;
  try {
    bound = await server.listen(port, '127.0.0.1');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(port);
    throw err;
  }
  debug(`http: listening on 127.0.0.1:${bound}`);

  writeJsonFile(daemonFilePath(configDir), {
    pid: process.pid,
    port: bound,
    startedAt: new Date().toISOString(),
    version,
  });

  if (opts.poll !== false) {
    poller.start();
    debug(`limits: polling every ${config.pollIntervalMs}ms`);
  }

  // Token store last: HTTP is already answering, and the store reports ready:false
  // until its initial scan finishes.
  if (opts.tokens === undefined) {
    const make = opts.createTokensSource ?? ((c: Config) => loadSpendStore(c, debug));
    const source = await make(config);
    if (source !== null) {
      server.setTokensSource(source);
      debug('spend: store attached');
    }
  }

  let stopped = false;
  return {
    port: bound,
    config,
    configDir,
    server,
    poller,
    async stop() {
      if (stopped) return;
      stopped = true;
      poller.stop();
      await server.close();
      try {
        rmSync(daemonFilePath(configDir), { force: true });
      } catch {
        // best effort
      }
      debug('daemon: stopped');
    },
  };
}

/**
 * `claude-usage serve` — start and keep running until SIGTERM/SIGINT, then flush,
 * remove `daemon.json` and exit 0. Port in use → exit 1 with a clear message.
 */
export async function serve(opts: DaemonOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let handle: DaemonHandle;
  try {
    handle = await startDaemon(opts);
  } catch (err) {
    if (err instanceof PortInUseError) {
      log(`claude-usage: ${err.message}`);
      return 1;
    }
    log(`claude-usage: failed to start — ${(err as Error).message}`);
    return 1;
  }

  log(`claude-usage ${handle.config.name} listening on http://127.0.0.1:${handle.port}`);

  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      log(`claude-usage: ${signal} received, shutting down`);
      void handle.stop().then(resolve, resolve);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
  return 0;
}
