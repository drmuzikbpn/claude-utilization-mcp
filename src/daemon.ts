import { rmSync } from 'node:fs';
import { createTokenReader } from './credentials/index.js';
import { EventBus } from './events/bus.js';
import { LimitsPoller } from './limits/poller.js';
import { ensureConfigDir, expandHome, loadConfig, resolveConfigDir, writeJsonFile, type Config } from './config.js';
import { daemonFilePath } from './clients/http.js';
import { resolveBindAddresses, TAILSCALE_KEYWORD } from './net/bind.js';
import { resolveMagicDnsName, resolveTailscaleIPv4 } from './net/tailscale.js';
import { isLoopbackAddress } from './server/middleware.js';
import { startBusPublishers } from './server/events.js';
import { createSessionsSubsystem, type SessionsSubsystem } from './sessions/index.js';
import { createServer, type UsageServer } from './server/index.js';
import type { TokensSource } from './server/types.js';
import { createUpdater, defaultRestart, type UpdaterHandle } from './update/index.js';
import { getVersion } from './version.js';

/**
 * The two tailnet questions the daemon asks at startup and again on `SIGHUP` (§16).
 * Injected in tests so nothing ever shells out to `tailscale`.
 */
export interface NetworkResolver {
  tailscaleIPv4(): Promise<string | null>;
  magicDnsName(): Promise<string | null>;
}

/**
 * How often to re-look for a tailnet address we want but do not have (§23.21). Only runs
 * while one is missing, so the steady-state cost is zero.
 */
export const TAILNET_RETRY_MS = 60_000;

export function defaultNetworkResolver(): NetworkResolver {
  return {
    tailscaleIPv4: () => resolveTailscaleIPv4(),
    magicDnsName: () => resolveMagicDnsName(),
  };
}

export interface DaemonOptions {
  configDir?: string;
  /** Pre-loaded config; otherwise read from `configDir`. */
  config?: Config;
  /** How often to retry a missing tailnet bind (§23.21); defaults to `TAILNET_RETRY_MS`. */
  tailnetRetryMs?: number;
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
  /** W3: shared event bus; created here when omitted. */
  bus?: EventBus;
  /** W3: start the sessions/pause subsystem (default `true`). */
  sessions?: boolean;
  /** W5: tailnet resolution seam (§16). */
  network?: NetworkResolver;
  /** W8: the auto-updater. Pass one to inject fakes; `null` leaves `/health.update` disabled. */
  updater?: UpdaterHandle | null;
}

export interface DaemonHandle {
  readonly port: number;
  readonly config: Config;
  readonly configDir: string;
  readonly server: UsageServer;
  readonly poller: LimitsPoller;
  /** Shared bus: `/v1/events` streams it, the daemon and W3 publish onto it (§19). */
  readonly bus: EventBus;
  readonly sessions: SessionsSubsystem | null;
  /** W8: the auto-updater feeding `/health.update`, or `null` when none runs (§20). */
  readonly updater: UpdaterHandle | null;
  /** The addresses currently listened on, in bind order. */
  readonly addresses: readonly string[];
  /** The MagicDNS name currently accepted in `Host`, or `null`. */
  readonly magicDnsName: string | null;
  /** `SIGHUP`: re-resolve the tailnet address and MagicDNS name, re-bind what changed (§16). */
  reload(): Promise<void>;
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

/** Build the real token store (§23.7: the store owns watcher-before-scan ordering). */
async function loadSpendStore(config: Config, configDir: string, log: (line: string) => void): Promise<TokensSource | null> {
  try {
    const { createSpendTokensSource } = await import('./spend/adapter.js');
    const store = createSpendTokensSource({
      projectsDir: expandHome(config.projectsDir),
      stateDir: configDir,
      onError: (err: unknown) => log(`spend: ${(err as Error).message ?? String(err)}`),
    });
    await store.start();
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
    // Serve the last good numbers straight away rather than an empty list until the first
    // poll lands — which matters now that auto-update restarts the daemon regularly, and
    // more still when that first poll comes back 429 (§23.19).
    configDir,
    log: debug,
  });

  // One bus per daemon: the SSE endpoint consumes it, sessions/pause + the daemon publish onto it (§19).
  const bus = opts.bus ?? new EventBus();
  let tokensSource: TokensSource | null = opts.tokens ?? null;
  // W3: sessions/pause subsystem — loads sessions.json / pause.json, runs the §18.3 orphan sweep,
  // starts the 15 s liveness timer. Token source is attached once the store is ready (below).
  const sessions = opts.sessions === false ? null : createSessionsSubsystem({ configDir, bus, tokens: tokensSource });
  sessions?.start();

  // --- §16: which addresses, and under which Host names ----------------------
  const network = opts.network ?? defaultNetworkResolver();
  // The MagicDNS name only matters when we are actually reachable over the tailnet, so a
  // loopback-only daemon never shells out to `tailscale` at all.
  const wantsTailnet = config.bind.some((entry) => entry.trim().toLowerCase() === TAILSCALE_KEYWORD);
  /**
   * The tailnet address the resolver last handed back, recorded as it goes past. Asking
   * "is a tailnet address listening?" needs both halves — whether one was found at all, and
   * whether the bind for it took — and only this callback sees the first.
   */
  let tailnetAddress: string | null = null;
  /** A tailnet address was found *and* we are listening on it. */
  const tailnetBound = (): boolean => tailnetAddress !== null && boundHosts.includes(tailnetAddress);
  const resolveTailscale = async (): Promise<string | null> => {
    tailnetAddress = await network.tailscaleIPv4();
    return tailnetAddress;
  };
  const addresses = await resolveBindAddresses(config.bind, { resolveTailscale, log });
  let magicDnsName = wantsTailnet ? await network.magicDnsName() : null;
  if (magicDnsName !== null) debug(`net: MagicDNS name ${magicDnsName}`);

  // --- §20: the auto-updater ------------------------------------------------
  // Built before the server so `/health.update` reads live state from the first
  // request; started after the listener is up so the first check never races boot.
  // `stopEverything` is filled in below — the updater restarts the process, and a
  // restart must run the same shutdown path as SIGTERM (SIGCONT'd pids, daemon.json).
  let stopEverything: () => Promise<void> = async () => {};
  const updater =
    opts.updater === undefined
      ? createUpdater({
          config,
          currentVersion: version,
          bus,
          log,
          debug,
          // §20: a hard freeze blocks the restart, so it blocks the update.
          hardFrozen: () => sessions?.registry.list().some((s) => s.pause?.mode === 'hard') ?? false,
          restart: async () => {
            await stopEverything();
            // Ask the supervisor, then exit non-zero — `defaultRestart` is the shared
            // implementation of both halves (§23.18). The exit alone is not enough: a
            // LaunchAgent bootstrapped from a non-GUI session never acts on it, and the
            // daemon that updated itself simply never came back (§23.20).
            await defaultRestart(process.env);
          },
        })
      : opts.updater;

  const server = createServer({
    config,
    limits: poller,
    tokens: tokensSource,
    ...(updater === null ? {} : { update: () => updater.status() }),
    version,
    bus,
    sessions,
    extraHostNames: magicDnsName === null ? [] : [magicDnsName],
    // §19: SSE snapshot carries the live sessions + pause rules.
    ...(sessions ? { snapshots: { sessions: () => sessions.registry.list(), rules: () => sessions.rules.list() } } : {}),
  });

  const port = opts.port ?? config.port;
  const boundHosts: string[] = [];
  // The first address decides the port and is fatal if it cannot be bound; every further
  // address is best-effort, because a tailnet that is down must not stop the daemon (§16).
  const [primary, ...secondary] = addresses as [string, ...string[]];
  let bound: number;
  try {
    bound = await server.listen(port, [primary]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(port);
    throw err;
  }
  boundHosts.push(primary);

  for (const host of secondary) {
    try {
      await server.bind(host, bound);
      boundHosts.push(host);
    } catch (err) {
      // A loopback alias that is taken means the port itself is contested — still fatal.
      if (isLoopbackAddress(host) && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        await server.close();
        throw new PortInUseError(bound);
      }
      log(`http: could not bind ${host}:${bound} — ${(err as Error).message}`);
    }
  }
  debug(`http: listening on ${boundHosts.map((h) => `${h}:${bound}`).join(', ')}`);

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

  // §20: disables itself when `autoUpdate.enabled` is false or we are not running out
  // of the `current` symlink, and schedules nothing in that case.
  updater?.start();

  // Token store last: HTTP is already answering, and the store reports ready:false
  // until its initial scan finishes.
  if (opts.tokens === undefined) {
    const make = opts.createTokensSource ?? ((c: Config) => loadSpendStore(c, configDir, debug));
    const source = await make(config);
    if (source !== null) {
      server.setTokensSource(source);
      sessions?.setTokensSource(source);
      tokensSource = source;
      debug('spend: store attached');
    }
  }

  // W4: feed the bus — `limits` on every poll that changed something, machine-wide
  // `spend` on every token-store change, coalesced to at most one per second (§19).
  const stopPublishers = startBusPublishers({ bus, limits: poller, tokens: () => tokensSource });

  let stopped = false;

  /**
   * `SIGHUP` (§16): the tailnet address and MagicDNS name can appear, change or vanish
   * while the daemon runs. Re-resolve both, bind whatever is newly available, drop what is
   * gone — and never let any of it be fatal. `config.json` itself is not re-read.
   */
  async function reload(): Promise<void> {
    if (stopped) return;
    let next: string[];
    try {
      next = await resolveBindAddresses(config.bind, { resolveTailscale, log });
    } catch (err) {
      log(`reload: keeping the current addresses — ${(err as Error).message}`);
      return;
    }

    for (const host of next) {
      if (boundHosts.includes(host)) continue;
      try {
        await server.bind(host, bound);
        boundHosts.push(host);
        log(`http: now also listening on ${host}:${bound}`);
      } catch (err) {
        log(`http: could not bind ${host}:${bound} — ${(err as Error).message}`);
      }
    }

    for (const host of [...boundHosts]) {
      if (next.includes(host)) continue;
      await server.unbind(host);
      boundHosts.splice(boundHosts.indexOf(host), 1);
      log(`http: stopped listening on ${host}:${bound}`);
    }

    const magic = wantsTailnet ? await network.magicDnsName() : null;
    if (magic !== magicDnsName) {
      magicDnsName = magic;
      server.setExtraHostNames(magic === null ? [] : [magic]);
      log(magic === null ? 'net: MagicDNS name is no longer available' : `net: MagicDNS name is now ${magic}`);
    }
  }

  /**
   * Retry the tailnet bind until it takes (§23.21).
   *
   * The tailnet address is resolved once at startup, and on a machine where Tailscale
   * starts *after* the daemon — or is down at boot — that resolve fails and nothing ever
   * tries again: the Mac Studio logged `could not bind 100.110.47.16 — EADDRNOTAVAIL` and
   * then served loopback and LAN only, with no tailnet listener, indefinitely. `SIGHUP`
   * fixes it, but only if a human knows to send one, and the whole point of the tailnet
   * address is to be reachable when nobody is at the machine.
   *
   * So: while a wanted address is missing, re-resolve on a timer. Once everything is bound
   * the timer stops and `SIGHUP` takes over again, so the steady-state cost is zero.
   */
  let tailnetRetry: ReturnType<typeof setTimeout> | null = null;
  function scheduleTailnetRetry(): void {
    if (stopped || !wantsTailnet || tailnetBound() || tailnetRetry !== null) return;
    tailnetRetry = setTimeout(() => {
      tailnetRetry = null;
      void (async () => {
        if (stopped) return;
        await reload().catch(() => undefined);
        if (tailnetBound()) log('net: tailnet address is now available');
        scheduleTailnetRetry();
      })();
    }, opts.tailnetRetryMs ?? TAILNET_RETRY_MS);
    tailnetRetry.unref();
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (tailnetRetry !== null) {
      clearTimeout(tailnetRetry);
      tailnetRetry = null;
    }
    // §18.3: SIGCONT every hard-frozen pid before anything else shuts down.
    sessions?.stop();
    updater?.stop();
    stopPublishers();
    poller.stop();
    await server.close();
    try {
      rmSync(daemonFilePath(configDir), { force: true });
    } catch {
      // best effort
    }
    debug('daemon: stopped');
  }
  stopEverything = stop;

  // Tailscale may not be up yet — keep trying rather than serving loopback for ever (§23.21).
  if (wantsTailnet && !tailnetBound()) {
    log('net: no tailnet address yet — will keep looking');
    scheduleTailnetRetry();
  }

  return {
    port: bound,
    config,
    configDir,
    server,
    poller,
    bus,
    sessions,
    updater,
    get addresses() {
      return boundHosts;
    },
    get magicDnsName() {
      return magicDnsName;
    },
    reload,
    stop,
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

  for (const address of handle.addresses) {
    const host = address.includes(':') ? `[${address}]` : address;
    log(`claude-usage ${handle.config.name} listening on http://${host}:${handle.port}`);
  }

  // §16: re-resolve the tailnet on SIGHUP; a reload never brings the daemon down.
  const reload = (): void => {
    log('claude-usage: SIGHUP received, re-resolving network addresses');
    void handle.reload().catch((err: unknown) => {
      log(`claude-usage: reload failed — ${(err as Error).message}`);
    });
  };
  process.on('SIGHUP', reload);

  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      log(`claude-usage: ${signal} received, shutting down`);
      process.removeListener('SIGHUP', reload);
      void handle.stop().then(resolve, resolve);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
  return 0;
}
