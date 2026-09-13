/**
 * The narrow contract the HTTP server consumes from the token-spend store.
 *
 * W1 owns the concrete implementation (`src/spend/index.ts` → `class SpendStore`);
 * this file is the shared declaration so the server can be built and tested against a
 * fake before that lands. `SpendStore` satisfies it structurally — do not import spend
 * types from here into `src/spend/**`.
 */

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  messages: number;
}

export type TokensGroupBy = 'project' | 'session' | 'model' | 'day';

export const TOKENS_GROUP_BY: readonly TokensGroupBy[] = ['project', 'session', 'model', 'day'];

export interface TokensQuery {
  /** Inclusive lower bound, ISO-8601. */
  since: string;
  groupBy: TokensGroupBy;
}

export interface TokensGroup extends TokenTotals {
  /** Opaque grouping key (for `project`, the `~/.claude/projects` dir name — §23.6). */
  key: string;
  /** Human-facing label; falls back to `key`. */
  label: string;
}

export interface TokensResponse {
  ready: boolean;
  stale: boolean;
  since: string;
  groupBy: TokensGroupBy;
  totals: TokenTotals;
  groups: TokensGroup[];
}

export interface ScanProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface ScanStats {
  filesTracked: number;
  eventsIndexed: number;
  parseErrors: number;
  lastScanAt: string | null;
  scan?: ScanProgress;
}

/** One transcript-known session (§17.2). `cwd` is the label the store recorded, if any. */
export interface TranscriptSession {
  sessionId: string;
  /** The `~/.claude/projects/<dir>` directory name, verbatim (§23.6). */
  projectKey: string;
  /** Most recent counted timestamp, ISO-8601. */
  lastActivityAt: string;
  /** cwd of the session's first top-level line; `''` when unknown. */
  cwd?: string;
}

export interface TokensSource {
  query(q: TokensQuery): TokensResponse;
  readonly ready: boolean;
  readonly stats: ScanStats;
  sessionTotals(sessionId: string): TokenTotals | null;
  sessionModel(sessionId: string): string | null;
  sessionStartedAt(sessionId: string): string | null;
  /**
   * Sessions the store has seen in transcripts — the source of §17.2's back-fill, which
   * surfaces them with `pid: null`, `discovered: "transcript"`. Optional so a `TokensSource`
   * that predates W3 (and the test fakes) still satisfies this interface.
   */
  listSessions?(): TranscriptSession[];
  /** Subscribe to store changes; returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
}

export function zeroTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0 };
}

export function emptyScanStats(): ScanStats {
  return { filesTracked: 0, eventsIndexed: 0, parseErrors: 0, lastScanAt: null };
}

export function isTokensGroupBy(v: unknown): v is TokensGroupBy {
  return typeof v === 'string' && (TOKENS_GROUP_BY as readonly string[]).includes(v);
}
