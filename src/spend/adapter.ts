import type { ScanStats as ServerScanStats, TokensSource } from '../server/types.js';
import { SpendStore, type SpendStoreOptions } from './index.js';

/**
 * Adapts W1's `SpendStore` (rich `ScanStats`) to the narrow `TokensSource` the server
 * consumes (§23.7 `/health.stats` shape). Everything else is structurally identical.
 */
export function createSpendTokensSource(options: SpendStoreOptions): TokensSource & { start(): Promise<void>; stop(): Promise<void> } {
  const store = new SpendStore(options);
  return {
    query: (q) => store.query(q),
    get ready() { return store.ready; },
    get stats(): ServerScanStats {
      const s = store.stats;
      return {
        filesTracked: s.filesTotal,
        eventsIndexed: s.dedupKeys,
        parseErrors: s.parseErrors,
        lastScanAt: s.lastScanAt,
        scan: { filesDone: s.filesDone, filesTotal: s.filesTotal, bytesDone: s.bytesDone, bytesTotal: s.bytesTotal },
      };
    },
    listSessions: () => store.listSessions(),
    sessionTotals: (id) => store.sessionTotals(id),
    sessionModel: (id) => store.sessionModel(id),
    sessionStartedAt: (id) => store.sessionStartedAt(id),
    onChange: (cb) => store.onChange(cb),
    start: () => store.start(),
    stop: () => store.stop(),
  };
}
