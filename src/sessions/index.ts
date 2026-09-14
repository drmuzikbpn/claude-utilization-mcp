/**
 * W3's single entry point: registry + pause rules + freezer + routes, wired together.
 *
 * `src/daemon.ts` creates one of these and hands it to `createServer`; nothing else in the
 * server knows about sessions.
 */

import type { EventBus } from '../events/bus.js';
import { PauseController } from '../pause/controller.js';
import { PauseRuleStore } from '../pause/rules.js';
import type { FreezeDeps } from '../pause/freeze.js';
import type { TokensSource } from '../server/types.js';
import { LIVENESS_INTERVAL_MS, SessionRegistry } from './registry.js';
import { createSessionsRouter, type SessionsRouter } from './routes.js';

export * from './types.js';
export { SessionRegistry, sessionsFilePath, resolveProject, SESSIONS_FILE } from './registry.js';
export { createSessionsRouter, type SessionsRouter, type SessionsApi } from './routes.js';

export interface SessionsSubsystemOptions {
  configDir: string;
  bus?: EventBus | null;
  tokens?: TokensSource | null;
  now?: () => number;
  livenessIntervalMs?: number;
  freezeDeps?: FreezeDeps;
  isAlive?: (pid: number) => boolean;
}

export interface SessionsSubsystem {
  registry: SessionRegistry;
  rules: PauseRuleStore;
  pause: PauseController;
  router: SessionsRouter;
  /** Load state, run the §18.3 orphan sweep, start the 15 s liveness timer. */
  start(): void;
  /** §18.3: SIGCONT every recorded frozen pid, then stop the timer. */
  stop(): void;
  setTokensSource(tokens: TokensSource | null): void;
}

export function createSessionsSubsystem(opts: SessionsSubsystemOptions): SessionsSubsystem {
  let unsubscribeTokens: (() => void) | null = null;
  const registry = new SessionRegistry({
    configDir: opts.configDir,
    tokens: opts.tokens ?? null,
    bus: opts.bus ?? null,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.isAlive === undefined ? {} : { isAlive: opts.isAlive }),
  });
  const rules = new PauseRuleStore({
    configDir: opts.configDir,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  const pause = new PauseController({
    registry,
    rules,
    bus: opts.bus ?? null,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.freezeDeps === undefined ? {} : { freezeDeps: opts.freezeDeps }),
  });
  const router = createSessionsRouter({ registry, pause });

  let started = false;
  return {
    registry,
    rules,
    pause,
    router,
    start() {
      if (started) return;
      started = true;
      registry.load();
      rules.load();
      pause.sweepOnStartup();
      registry.start(opts.livenessIntervalMs ?? LIVENESS_INTERVAL_MS);
    },
    stop() {
      unsubscribeTokens?.();
      unsubscribeTokens = null;
      registry.stop();
      pause.thawEverything();
      registry.save();
      started = false;
    },
    setTokensSource(tokens) {
      registry.setTokensSource(tokens);
      unsubscribeTokens?.();
      unsubscribeTokens = tokens?.onChange(() => registry.refreshTitles()) ?? null;
      registry.refreshTitles();
    },
  };
}
