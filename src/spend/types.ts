/**
 * Public types for the token-spend subsystem (spec §5.3, §23.4–23.8).
 *
 * Counters are raw token counts; no pricing is applied anywhere in this module.
 */

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  messages: number;
}

export type GroupBy = 'project' | 'session' | 'model' | 'day';

export interface TokensQuery {
  /** ISO-8601 instant, `<N>d`, `<N>h`, or `today` (UTC day). */
  since: string;
  groupBy: GroupBy;
}

export interface TokensGroup extends TokenTotals {
  /** Opaque grouping key (project dir name, sessionId, model id, or `YYYY-MM-DD`). */
  key: string;
  /** Human-facing label; falls back to `key` when nothing better is known. */
  label: string;
}

export interface TokensResponse {
  /** `false` until the initial scan completes; totals/groups are empty meanwhile. */
  ready: boolean;
  /** `true` while a background rescan is reconciling the aggregates being served. */
  stale: boolean;
  /** The resolved lower bound, as an ISO-8601 instant. */
  since: string;
  groupBy: GroupBy;
  totals: TokenTotals;
  groups: TokensGroup[];
}

export interface ScanStats {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Lines that were not valid JSON. Skipped non-usage lines are *not* counted here. */
  parseErrors: number;
  /** Distinct `message.id:requestId` keys currently retained. */
  dedupKeys: number;
  /** Distinct sessions currently retained. */
  sessions: number;
  /** ISO-8601 instant the last scan finished, or `null` if none has. */
  lastScanAt: string | null;
  /** `true` while a scan is in progress. */
  scanning: boolean;
}

/** One counted assistant line, normalized. */
export interface UsageEvent {
  /** `message.id + ':' + (requestId ?? '')` — never built from `undefined`. */
  dedupKey: string;
  /** UTC calendar day of `timestamp`, `YYYY-MM-DD`. */
  day: string;
  /** ISO-8601 instant from the line's `timestamp`. */
  timestamp: string;
  /** The `~/.claude/projects/<dir>` directory name, verbatim and opaque. */
  projectKey: string;
  sessionId: string;
  model: string;
  /** The line's own `cwd`; drifts for subagents, so it is a label source, not a key. */
  cwd: string;
  /** `true` for `<project>/<sessionId>.jsonl`, `false` for nested subagent transcripts. */
  topLevel: boolean;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0 };
}
