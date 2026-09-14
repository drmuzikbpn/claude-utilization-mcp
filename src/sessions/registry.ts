/**
 * The session registry (§17).
 *
 * Sessions are discovered through our own hooks (`SessionStart` → `register`), kept alive by
 * `UserPromptSubmit` heartbeats, and reconciled every 15 s with `kill(pid, 0)`. Sessions the
 * hooks never saw are back-filled from the spend store with `pid: null`,
 * `discovered: "transcript"`.
 *
 * Persistence lives in `<configDir>/sessions.json` — deliberately NOT `state.json`, which
 * W1's `SpendStore` owns in the same directory. Written atomically at 0600.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { isPidAlive } from '../clients/http.js';
import { writeJsonFile } from '../config.js';
import type { EventBus } from '../events/bus.js';
import { zeroTotals, type TokensSource } from '../server/types.js';
import type {
  LastTool,
  PauseTarget,
  RegisterInput,
  SessionPause,
  SessionProject,
  SessionView,
  StoredSession,
} from './types.js';

export const SESSIONS_FILE = 'sessions.json';
export const SESSIONS_FILE_VERSION = 1;
/** §17.2: liveness sweep interval. */
export const LIVENESS_INTERVAL_MS = 15_000;
/** §17.2: how long a dead session stays visible so the dashboard sees the exit. */
export const DEAD_RETENTION_MS = 5 * 60_000;

export function sessionsFilePath(configDir: string): string {
  return join(configDir, SESSIONS_FILE);
}

/** Strip a trailing slash so `/a/b/` and `/a/b` compare equal. */
function normalizeDir(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

/**
 * §17.3 project grouping. `project.name` is the basename of the main worktree (the parent
 * of `gitCommonDir`); `worktree` is `basename(cwd)` when `cwd` is not the main worktree.
 * `gitCommonDir: null` → the project is just `basename(cwd)`.
 */
export function resolveProject(
  cwd: string,
  gitCommonDir: string | null,
): { project: SessionProject; worktree: string | null } {
  if (gitCommonDir === null || gitCommonDir.length === 0) {
    const name = cwd.length === 0 ? '(unknown)' : basename(normalizeDir(cwd));
    return { project: { gitCommonDir: null, name: name.length === 0 ? cwd : name }, worktree: null };
  }
  const common = normalizeDir(gitCommonDir);
  const mainWorktree = normalizeDir(dirname(common));
  const name = basename(mainWorktree);
  const here = normalizeDir(cwd);
  const worktree = here.length > 0 && here !== mainWorktree ? basename(here) : null;
  return { project: { gitCommonDir: common, name: name.length === 0 ? common : name }, worktree };
}

/** The main worktree directory a `project:` rule may also be spelled with. */
export function mainWorktreeOf(gitCommonDir: string | null): string | null {
  if (gitCommonDir === null || gitCommonDir.length === 0) return null;
  return normalizeDir(dirname(normalizeDir(gitCommonDir)));
}

export interface SessionRegistryOptions {
  configDir: string;
  tokens?: TokensSource | null;
  bus?: EventBus | null;
  now?: () => number;
  /** Test seam for the liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Called after any change that bumps `rev`. */
  onChange?: () => void;
}

interface PersistedFile {
  version?: number;
  rev?: number;
  sessions?: StoredSession[];
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** A transcript written within this window counts as a live (pre-install) session. */
export const TRANSCRIPT_ALIVE_MS = 10 * 60_000;
/** Transcript-only sessions older than this are not back-filled into `/v1/sessions`. */
export const TRANSCRIPT_BACKFILL_MS = 24 * 60 * 60_000;

export class SessionRegistry {
  readonly configDir: string;
  #sessions = new Map<string, StoredSession>();
  #rev = 0;
  #tokens: TokensSource | null;
  #bus: EventBus | null;
  #now: () => number;
  #isAlive: (pid: number) => boolean;
  #onChange: () => void;
  #timer: NodeJS.Timeout | null = null;
  #resolvePause: (target: PauseTarget) => { pause: SessionPause | null } = () => ({ pause: null });
  #releaseFreeze: ((pids: readonly number[]) => void) | null = null;

  constructor(opts: SessionRegistryOptions) {
    this.configDir = opts.configDir;
    this.#tokens = opts.tokens ?? null;
    this.#bus = opts.bus ?? null;
    this.#now = opts.now ?? Date.now;
    this.#isAlive = opts.isAlive ?? isPidAlive;
    this.#onChange = opts.onChange ?? ((): void => {});
  }

  get rev(): number {
    return this.#rev;
  }

  /** Bumped on any session *or* pause change (§17.3); the pause controller calls this too. */
  bumpRev(): number {
    this.#rev += 1;
    this.#onChange();
    return this.#rev;
  }

  setTokensSource(tokens: TokensSource | null): void {
    this.#tokens = tokens;
  }

  #titleCache = new Map<string, string | null>();

  /** Transcript record first (the store already parses those), sidecar file as fallback. */
  #titleFor(sessionId: string, transcriptPath: string | null): string | null {
    const fromStore = this.#tokens?.sessionTitle?.(sessionId) ?? null;
    if (fromStore !== null) return fromStore;
    if (transcriptPath === null || !transcriptPath.endsWith('.jsonl')) return null;
    try {
      const sidecar = join(dirname(transcriptPath), sessionId, 'custom-title.json');
      const parsed = JSON.parse(readFileSync(sidecar, 'utf8')) as { customTitle?: unknown };
      const title = typeof parsed.customTitle === 'string' ? parsed.customTitle.trim() : '';
      return title.length > 0 ? title : null;
    } catch {
      return null;
    }
  }

  /** Called on token-store changes: publish `update` for any registered session whose title changed. */
  refreshTitles(): void {
    for (const session of this.#sessions.values()) {
      const title = this.#titleFor(session.sessionId, session.transcriptPath);
      const previous = this.#titleCache.get(session.sessionId);
      if (previous !== undefined && previous === title) continue;
      this.#titleCache.set(session.sessionId, title);
      if (previous !== undefined) {
        this.bumpRev();
        this.publish('update', session);
      }
    }
  }

  /** Injected by the pause controller so a rendered session carries its effective pause. */
  setPauseResolver(fn: (target: PauseTarget) => { pause: SessionPause | null }): void {
    this.#resolvePause = fn;
  }

  /**
   * Injected by the pause controller: SIGCONT a frozen tree the registry is about to forget.
   * Without it, `claude --resume` (a new pid for the same session id) drops the old
   * `frozenPids` on the floor and its stopped tool subprocesses — now reparented to init —
   * stay stopped for good, which is exactly the invariant hard freeze is not allowed to break.
   */
  setFreezeReleaser(fn: (pids: readonly number[]) => void): void {
    this.#releaseFreeze = fn;
  }

  // --- persistence ----------------------------------------------------------

  load(): void {
    let parsed: PersistedFile;
    try {
      parsed = JSON.parse(readFileSync(sessionsFilePath(this.configDir), 'utf8')) as PersistedFile;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    for (const entry of list) {
      if (typeof entry?.sessionId !== 'string' || entry.sessionId.length === 0) continue;
      this.#sessions.set(entry.sessionId, {
        sessionId: entry.sessionId,
        pid: typeof entry.pid === 'number' ? entry.pid : null,
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        transcriptPath: typeof entry.transcriptPath === 'string' ? entry.transcriptPath : null,
        gitCommonDir: typeof entry.gitCommonDir === 'string' ? entry.gitCommonDir : null,
        source: typeof entry.source === 'string' ? entry.source : null,
        registeredAt: typeof entry.registeredAt === 'string' ? entry.registeredAt : isoOf(this.#now()),
        lastActivityAt: typeof entry.lastActivityAt === 'string' ? entry.lastActivityAt : isoOf(this.#now()),
        alive: entry.alive !== false,
        deadSince: typeof entry.deadSince === 'number' ? entry.deadSince : null,
        frozenPids: Array.isArray(entry.frozenPids) ? entry.frozenPids.filter((p) => typeof p === 'number') : [],
        frozenPid: typeof entry.frozenPid === 'number' ? entry.frozenPid : null,
        freezes: typeof entry.freezes === 'number' && entry.freezes > 0 ? Math.floor(entry.freezes) : 0,
        pausedSince: typeof entry.pausedSince === 'string' ? entry.pausedSince : null,
        lastTool:
          entry.lastTool !== null && typeof entry.lastTool === 'object' && typeof entry.lastTool.name === 'string'
            ? { name: entry.lastTool.name, at: String(entry.lastTool.at ?? isoOf(this.#now())) }
            : null,
      });
    }
    if (typeof parsed.rev === 'number' && Number.isFinite(parsed.rev)) this.#rev = parsed.rev;
  }

  save(): void {
    try {
      writeJsonFile(sessionsFilePath(this.configDir), {
        version: SESSIONS_FILE_VERSION,
        rev: this.#rev,
        sessions: [...this.#sessions.values()],
      });
    } catch {
      // Persistence is best effort — never fail a request because of bookkeeping.
    }
  }

  // --- mutation -------------------------------------------------------------

  /** Idempotent: `claude --resume` re-registers the same id with a new pid (§17.1). */
  register(input: RegisterInput): StoredSession {
    const nowIso = isoOf(this.#now());
    const existing = this.#sessions.get(input.sessionId);
    const samePid = existing !== undefined && existing.pid === (input.pid ?? null);
    if (!samePid && existing !== undefined && existing.frozenPids.length > 0) {
      this.#releaseFreeze?.(existing.frozenPids);
    }
    const session: StoredSession = {
      sessionId: input.sessionId,
      pid: typeof input.pid === 'number' && input.pid > 0 ? input.pid : null,
      cwd: input.cwd ?? existing?.cwd ?? '',
      transcriptPath: input.transcriptPath ?? existing?.transcriptPath ?? null,
      gitCommonDir: input.gitCommonDir ?? existing?.gitCommonDir ?? null,
      source: input.source ?? existing?.source ?? null,
      registeredAt: existing?.registeredAt ?? nowIso,
      lastActivityAt: nowIso,
      alive: true,
      deadSince: null,
      // A re-register with a new pid invalidates the old frozen tree. `frozenPid` is kept
      // as it was so the reconciler sees it no longer matches `pid` and freezes the new
      // tree, and `freezes` keeps counting — that is what tells a dashboard "frozen again
      // after re-register" apart from "frozen once" (§23.16).
      frozenPids: samePid ? existing.frozenPids : [],
      frozenPid: existing?.frozenPid ?? null,
      freezes: existing?.freezes ?? 0,
      pausedSince: existing?.pausedSince ?? null,
      lastTool: existing?.lastTool ?? null,
    };
    this.#sessions.set(session.sessionId, session);
    this.bumpRev();
    this.save();
    this.publish(existing === undefined ? 'start' : 'update', session);
    return session;
  }

  heartbeat(sessionId: string): StoredSession | null {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    session.lastActivityAt = isoOf(this.#now());
    session.alive = true;
    session.deadSince = null;
    this.bumpRev();
    this.save();
    this.publish('update', session);
    return session;
  }

  /** §23.13: the `PreToolUse` gate records the tool it is gating. */
  recordTool(sessionId: string, tool: string): StoredSession | null {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    const at = isoOf(this.#now());
    const last: LastTool = { name: tool, at };
    session.lastTool = last;
    session.lastActivityAt = at;
    this.bumpRev();
    this.save();
    this.publish('update', session);
    return session;
  }

  end(sessionId: string): StoredSession | null {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    this.#sessions.delete(sessionId);
    this.bumpRev();
    this.save();
    this.publish('end', session);
    return session;
  }

  /**
   * Record a freeze: the stopped tool pids, the root they belong to, and one more tick on
   * the freeze counter the dashboard reads (§23.16). `pids` may legitimately be empty — a
   * session with no tool running has nothing to stop.
   */
  recordFreeze(sessionId: string, frozenPid: number | null, pids: readonly number[], pausedSince: string): number {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return 0;
    session.frozenPids = [...pids];
    session.frozenPid = frozenPid;
    session.freezes += 1;
    session.pausedSince = pausedSince;
    this.save();
    return session.freezes;
  }

  /**
   * Forget the recorded freeze. `pausedSince === null` ends the pause outright and resets the
   * freeze counter with it; a non-null value keeps the count across a hard → soft downgrade.
   */
  clearFreeze(sessionId: string, pausedSince: string | null): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    session.frozenPids = [];
    session.frozenPid = null;
    if (pausedSince === null) session.freezes = 0;
    session.pausedSince = pausedSince;
    this.save();
  }

  get(sessionId: string): StoredSession | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  all(): StoredSession[] {
    return [...this.#sessions.values()];
  }

  // --- liveness -------------------------------------------------------------

  /**
   * §17.2: `kill(pid, 0)` each registered pid; dead → `alive: false`, dropped after 5 min.
   * Returns what changed so the caller can re-apply pause rules.
   */
  checkLiveness(): { died: StoredSession[]; dropped: StoredSession[] } {
    const died: StoredSession[] = [];
    const dropped: StoredSession[] = [];
    const now = this.#now();
    for (const session of [...this.#sessions.values()]) {
      if (session.pid === null) continue;
      const alive = this.#isAlive(session.pid);
      if (alive) {
        if (!session.alive) {
          session.alive = true;
          session.deadSince = null;
          this.bumpRev();
          this.publish('update', session);
        }
        continue;
      }
      if (session.alive) {
        session.alive = false;
        session.deadSince = now;
        died.push(session);
        this.bumpRev();
        this.publish('update', session);
        continue;
      }
      if (session.deadSince !== null && now - session.deadSince >= DEAD_RETENTION_MS) {
        this.#sessions.delete(session.sessionId);
        dropped.push(session);
        this.bumpRev();
        this.publish('end', session);
      }
    }
    if (died.length > 0 || dropped.length > 0) this.save();
    return { died, dropped };
  }

  start(intervalMs: number = LIVENESS_INTERVAL_MS): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      this.checkLiveness();
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  // --- views ----------------------------------------------------------------

  view(session: StoredSession): SessionView {
    const { project, worktree } = resolveProject(session.cwd, session.gitCommonDir);
    const { pause } = this.#resolvePause({
      sessionId: session.sessionId,
      gitCommonDir: session.gitCommonDir,
      cwd: session.cwd,
    });
    return {
      sessionId: session.sessionId,
      pid: session.pid,
      alive: session.alive,
      discovered: 'hook',
      cwd: session.cwd,
      transcriptPath: session.transcriptPath,
      project,
      worktree,
      model: this.#tokens?.sessionModel(session.sessionId) ?? null,
      startedAt: this.#tokens?.sessionStartedAt(session.sessionId) ?? session.registeredAt,
      lastActivityAt: session.lastActivityAt,
      tokens: this.#tokens?.sessionTotals(session.sessionId) ?? zeroTotals(),
      pause,
      lastTool: session.lastTool,
      title: this.#titleFor(session.sessionId, session.transcriptPath),
    };
  }

  /** Registered sessions plus the spend store's transcript back-fill (§17.2). */
  list(): SessionView[] {
    const views: SessionView[] = this.all().map((s) => this.view(s));
    const known = new Set(views.map((v) => v.sessionId));
    const tokens = this.#tokens;
    if (tokens !== null && typeof tokens.listSessions === 'function') {
      const now = this.#now();
      for (const entry of tokens.listSessions()) {
        if (known.has(entry.sessionId)) continue;
        // Pre-install sessions have no SessionStart registration. A transcript that is still
        // being written is treated as alive; anything older than the back-fill window is
        // omitted so a snapshot doesn't carry every session from the last 90 days.
        const age = now - Date.parse(entry.lastActivityAt);
        if (!(age < TRANSCRIPT_BACKFILL_MS)) continue;
        const cwd = entry.cwd ?? '';
        const { project, worktree } = resolveProject(cwd, null);
        const { pause } = this.#resolvePause({ sessionId: entry.sessionId, gitCommonDir: null, cwd });
        views.push({
          sessionId: entry.sessionId,
          pid: null,
          alive: age < TRANSCRIPT_ALIVE_MS,
          discovered: 'transcript',
          cwd,
          transcriptPath: null,
          project: cwd.length === 0 ? { gitCommonDir: null, name: entry.projectKey } : project,
          worktree,
          model: tokens.sessionModel(entry.sessionId),
          startedAt: tokens.sessionStartedAt(entry.sessionId),
          lastActivityAt: entry.lastActivityAt,
          tokens: tokens.sessionTotals(entry.sessionId) ?? zeroTotals(),
          pause,
          lastTool: null,
          title: this.#titleFor(entry.sessionId, null),
        });
      }
    }
    views.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
    return views;
  }

  /** A view for a session id whether it is registered or only known from transcripts. */
  viewOf(sessionId: string): SessionView | null {
    return this.list().find((v) => v.sessionId === sessionId) ?? null;
  }

  publish(type: 'start' | 'end' | 'update', session: StoredSession): void {
    this.#bus?.publish('session', { type, session: this.view(session) });
  }
}

/** Resolve `git rev-parse --git-common-dir` output to an absolute path (§17.1). */
export function absoluteGitCommonDir(raw: string, cwd: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  return isAbsolute(trimmed) ? normalizeDir(trimmed) : normalizeDir(resolvePath(cwd, trimmed));
}
