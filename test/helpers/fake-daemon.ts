import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../../src/config.js';
import { daemonFilePath } from '../../src/clients/http.js';
import { createServer, type UsageServer } from '../../src/server/index.js';
import { FakeLimitsProvider, FakeTokensSource, snapshotWithPercents, testConfig } from './fakes.js';
import type { LimitsSnapshot } from '../../src/limits/types.js';

export interface FakeDaemon {
  server: UsageServer;
  port: number;
  configDir: string;
  limits: FakeLimitsProvider;
  setPercents(percents: Record<string, number>, severity?: Record<string, string>): void;
  stop(): Promise<void>;
}

export function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'cu-xdg-'));
}

export interface FakeDaemonOptions {
  configDir?: string;
  snapshot?: LimitsSnapshot;
  tokensReady?: boolean;
  /** Write daemon.json so clients can discover the port. */
  writeDaemonFile?: boolean;
}

/** A real server on port 0, discoverable through a temp `daemon.json`. */
export async function startFakeDaemon(opts: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const configDir = opts.configDir ?? tempConfigDir();
  const limits = new FakeLimitsProvider(opts.snapshot);
  const server = createServer({
    config: testConfig(),
    limits,
    tokens: new FakeTokensSource({ ready: opts.tokensReady ?? true, totals: { input: 1234, output: 567, messages: 8 } }),
    version: '9.9.9',
  });
  const port = await server.listen(0, '127.0.0.1');
  if (opts.writeDaemonFile !== false) {
    writeJsonFile(daemonFilePath(configDir), {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      version: '9.9.9',
    });
  }
  return {
    server,
    port,
    configDir,
    limits,
    setPercents(percents, severity) {
      limits.set(snapshotWithPercents(percents, severity));
    },
    stop: () => server.close(),
  };
}
