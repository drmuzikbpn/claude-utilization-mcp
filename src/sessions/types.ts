/**
 * Session shapes for `/v1/sessions` and the SSE `session` event (§17.3, §23.13).
 *
 * `StoredSession` is what we persist in `<configDir>/sessions.json`; `SessionView` is the
 * wire shape. They are deliberately different: the wire shape folds in the spend store
 * (`model`, `tokens`, `startedAt`) and the pause resolution, neither of which is ours to
 * persist.
 */

import type { TokenTotals } from '../server/types.js';

export type PauseMode = 'soft' | 'hard';
export type Discovered = 'hook' | 'transcript';

/** `POST /v1/sessions/register` body (§17.1). */
export interface RegisterInput {
  sessionId: string;
  /** The `claude` process — the hook's own `ppid`. `null` is never sent by our hook. */
  pid?: number | null;
  cwd?: string;
  transcriptPath?: string | null;
  /** `git rev-parse --git-common-dir` resolved absolute in `cwd`, or `null`. */
  gitCommonDir?: string | null;
  /** Claude Code's `source` field (`startup`, `resume`, `clear`, …). Advisory. */
  source?: string | null;
}

export interface LastTool {
  name: string;
  at: string;
}

export interface SessionProject {
  gitCommonDir: string | null;
  name: string;
}

export interface SessionPause {
  mode: PauseMode;
  ruleId: string;
  scope: string;
  since: string;
  frozenPids: number[];
}

/** One entry of `<configDir>/sessions.json`. */
export interface StoredSession {
  sessionId: string;
  pid: number | null;
  cwd: string;
  transcriptPath: string | null;
  gitCommonDir: string | null;
  source: string | null;
  registeredAt: string;
  lastActivityAt: string;
  alive: boolean;
  /** Epoch ms the pid was first seen dead; drives the 5 min drop (§17.2). */
  deadSince: number | null;
  /** Recorded by hard freeze, parent first (§18.3). */
  frozenPids: number[];
  /** ISO instant the current effective pause started, `null` when not paused. */
  pausedSince: string | null;
  lastTool: LastTool | null;
}

/** The `/v1/sessions` element (§17.3 + §23.13 `lastTool`). */
export interface SessionView {
  sessionId: string;
  pid: number | null;
  alive: boolean;
  discovered: Discovered;
  cwd: string;
  transcriptPath: string | null;
  project: SessionProject;
  worktree: string | null;
  model: string | null;
  startedAt: string | null;
  lastActivityAt: string;
  tokens: TokenTotals;
  pause: SessionPause | null;
  lastTool: LastTool | null;
  /** `/rename` title (§23.14): transcript `custom-title` record, else the sidecar file; null when never renamed. */
  title: string | null;
}

/** The subset of a session the pause rules match against. */
export interface PauseTarget {
  sessionId: string;
  gitCommonDir: string | null;
  cwd: string;
}
