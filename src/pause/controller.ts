/**
 * Ties the pause rules (§18.1) to the session registry (§17) and the freezer (§18.3).
 *
 * Every state change funnels through `apply()`, which reconciles the actual SIGSTOP state of
 * every session with the rules. That is what makes the safety invariants checkable: startup
 * sweep, shutdown thaw and "resume" are all the same reconciliation with different inputs.
 */

import type { EventBus } from '../events/bus.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { PauseMode, PauseTarget, SessionPause, StoredSession } from '../sessions/types.js';
import { defaultFreezeDeps, FreezeRefused, freezeTree, thaw, type FreezeDeps } from './freeze.js';
import { parseScope, PauseRuleStore, type CreatedBy, type PauseRule, ruleMatches } from './rules.js';

export interface GateResult {
  paused: boolean;
  mode: PauseMode | null;
  ruleId: string | null;
  reason: string | null;
}

export type PauseOutcome =
  | { ok: true; rule: PauseRule; created: boolean; affected: string[] }
  | { ok: false; status: 409 | 410; code: 'conflict' | 'gone'; message: string; hint?: string };

export interface PauseControllerOptions {
  registry: SessionRegistry;
  rules: PauseRuleStore;
  bus?: EventBus | null;
  now?: () => number;
  freezeDeps?: FreezeDeps;
}

export class PauseController {
  readonly registry: SessionRegistry;
  readonly rules: PauseRuleStore;
  #bus: EventBus | null;
  #now: () => number;
  #deps: FreezeDeps;

  constructor(opts: PauseControllerOptions) {
    this.registry = opts.registry;
    this.rules = opts.rules;
    this.#bus = opts.bus ?? null;
    this.#now = opts.now ?? Date.now;
    this.#deps = opts.freezeDeps ?? defaultFreezeDeps();
    this.registry.setPauseResolver((target) => ({ pause: this.resolvePause(target) }));
  }

  // --- resolution -----------------------------------------------------------

  resolvePause(target: PauseTarget): SessionPause | null {
    const rule = this.rules.effectiveFor(target);
    if (rule === null) return null;
    const stored = this.registry.get(target.sessionId);
    return {
      mode: rule.mode,
      ruleId: rule.id,
      scope: rule.scope,
      since: stored?.pausedSince ?? rule.createdAt,
      frozenPids: stored?.frozenPids ?? [],
      freezes: stored?.freezes ?? 0,
    };
  }

  targetOf(sessionId: string): PauseTarget {
    const stored = this.registry.get(sessionId);
    if (stored !== null) return { sessionId, gitCommonDir: stored.gitCommonDir, cwd: stored.cwd };
    const view = this.registry.viewOf(sessionId);
    if (view !== null) return { sessionId, gitCommonDir: view.project.gitCommonDir, cwd: view.cwd };
    // An unknown session still inherits `all` (and any cwd-less project rule): fail closed
    // for the dashboard's big red button, fail open only when the daemon is unreachable.
    return { sessionId, gitCommonDir: null, cwd: '' };
  }

  /** The hooks' soft-pause gate (§18.2); `tool` comes from `PreToolUse` (§23.13). */
  gate(sessionId: string, tool?: string | undefined): GateResult {
    if (typeof tool === 'string' && tool.length > 0) this.registry.recordTool(sessionId, tool);
    const rule = this.rules.effectiveFor(this.targetOf(sessionId));
    if (rule === null) return { paused: false, mode: null, ruleId: null, reason: null };
    return { paused: true, mode: rule.mode, ruleId: rule.id, reason: rule.reason };
  }

  // --- reconciliation -------------------------------------------------------

  /**
   * Make the world match the rules. `refreeze` re-resolves the process tree even when this
   * pid's tree is already recorded (the startup sweep, where recorded pids may be stale).
   *
   * "Already frozen" is `frozenPid === pid`, not `frozenPids.length > 0`: a hard freeze
   * stops only the tool subprocesses (§23.16), so an idle session legitimately freezes to an
   * empty list and must not be re-swept on every reconcile. Keying on the root pid also
   * makes a re-registered session (`claude --resume`, new pid) freeze its new tree.
   */
  apply(opts: { refreeze?: boolean } = {}): string[] {
    const affected: string[] = [];
    const nowIso = new Date(this.#now()).toISOString();
    let changed = false;

    for (const session of this.registry.all()) {
      const rule = this.rules.effectiveFor({
        sessionId: session.sessionId,
        gitCommonDir: session.gitCommonDir,
        cwd: session.cwd,
      });
      if (rule !== null) affected.push(session.sessionId);

      const wantHard = rule !== null && rule.mode === 'hard' && session.alive && session.pid !== null;
      if (wantHard) {
        if (session.frozenPid !== session.pid || opts.refreeze === true) {
          if (session.frozenPids.length > 0) thaw(session.frozenPids, this.#deps);
          try {
            const pids = freezeTree(session.pid, this.#deps);
            this.registry.recordFreeze(session.sessionId, session.pid, pids, session.pausedSince ?? nowIso);
            changed = true;
          } catch (err) {
            if (!(err instanceof FreezeRefused)) throw err;
            // Untrusted pid: the rule still stands as a soft stop at the next boundary, and
            // the freeze stays unrecorded so a later reconcile can try again.
            this.registry.clearFreeze(session.sessionId, session.pausedSince ?? nowIso);
          }
        }
        continue;
      }

      if (session.frozenPids.length > 0 || session.frozenPid !== null) {
        // Covers the hard → soft downgrade as well as a full resume: forgetting the root pid
        // is what lets a re-escalation freeze again.
        thaw(session.frozenPids, this.#deps);
        this.registry.clearFreeze(session.sessionId, rule === null ? null : (session.pausedSince ?? nowIso));
        changed = true;
        continue;
      }
      if (rule === null && session.pausedSince !== null) {
        this.registry.clearFreeze(session.sessionId, null);
        changed = true;
      } else if (rule !== null && session.pausedSince === null) {
        this.registry.clearFreeze(session.sessionId, nowIso);
        changed = true;
      }
    }
    if (changed) this.registry.save();
    return affected;
  }

  /** §18.3 startup sweep: re-freeze live matching sessions, SIGCONT everything else. */
  sweepOnStartup(): string[] {
    return this.apply({ refreeze: true });
  }

  /**
   * SIGCONT one session's recorded tree — used when a session ends while frozen, so a
   * stopped process can never outlive the session that owned it (§18.3).
   */
  thawSession(session: StoredSession): number[] {
    if (session.frozenPids.length === 0) return [];
    return thaw(session.frozenPids, this.#deps);
  }

  /** §18.3: clean shutdown SIGCONTs every recorded pid first. Rules are left alone. */
  thawEverything(): number[] {
    const resumed: number[] = [];
    for (const session of this.registry.all()) {
      if (session.frozenPids.length === 0) continue;
      for (const pid of thaw(session.frozenPids, this.#deps)) resumed.push(pid);
      this.registry.clearFreeze(session.sessionId, session.pausedSince);
    }
    if (resumed.length > 0) this.registry.save();
    return resumed;
  }

  // --- mutations ------------------------------------------------------------

  /** Refuse a hard freeze we could not honour, before any rule is created (§18.3). */
  #checkHardTarget(sessionId: string): PauseOutcome | null {
    const session: StoredSession | null = this.registry.get(sessionId);
    if (session === null) {
      const view = this.registry.viewOf(sessionId);
      if (view !== null && view.discovered === 'transcript') {
        return {
          ok: false,
          status: 409,
          code: 'conflict',
          message: `session ${sessionId} was discovered from its transcript and has no trusted pid`,
          hint: 'hard freeze needs a session registered by the SessionStart hook — use mode "soft"',
        };
      }
      return {
        ok: false,
        status: 410,
        code: 'gone',
        message: `session ${sessionId} is not running`,
        hint: 'the process has exited; no rule was created',
      };
    }
    if (!session.alive || session.pid === null) {
      return {
        ok: false,
        status: 410,
        code: 'gone',
        message: `session ${sessionId} has exited`,
        hint: 'no rule was created',
      };
    }
    const owner = this.#deps.uidOf(session.pid);
    if (owner === null) {
      return {
        ok: false,
        status: 410,
        code: 'gone',
        message: `process ${session.pid} for session ${sessionId} is gone`,
        hint: 'no rule was created',
      };
    }
    if (owner !== this.#deps.selfUid()) {
      return {
        ok: false,
        status: 409,
        code: 'conflict',
        message: `process ${session.pid} is not owned by this user`,
        hint: 'claude-usage only freezes processes it owns',
      };
    }
    return null;
  }

  pause(input: { scope: string; mode: PauseMode; reason?: string | undefined; createdBy: CreatedBy }): PauseOutcome {
    const parsed = parseScope(input.scope);
    if (parsed !== null && parsed.kind === 'session' && input.mode === 'hard') {
      const refusal = this.#checkHardTarget(parsed.value);
      if (refusal !== null) return refusal;
    }
    const { rule, created } = this.rules.add(input);
    const affected = this.apply();
    this.registry.bumpRev();
    this.#bus?.publish('pause', { rules: this.rules.list(), affected });
    return { ok: true, rule, created, affected };
  }

  /**
   * Does `rule` cover a session that the resume target also covers? Used so a project
   * resume lifts the session rules inside that project (a dashboard escalating one session
   * to hard should not have to fan out its own cleanup).
   */
  #isRuleUnderScope(rule: PauseRule, scope: string): boolean {
    const parsed = parseScope(rule.scope);
    if (parsed === null || parsed.kind !== 'session') return false;
    const session = this.registry.get(parsed.value);
    if (session === null) return false;
    return ruleMatches({ ...rule, scope }, {
      sessionId: session.sessionId,
      gitCommonDir: session.gitCommonDir,
      cwd: session.cwd,
    });
  }

  /** §18.4: idempotent — empty arrays when nothing matched. */
  resume(scope: string): { removed: string[]; resumed: string[] } {
    const before = new Map(this.registry.all().map((s) => [s.sessionId, this.rules.effectiveFor({
      sessionId: s.sessionId,
      gitCommonDir: s.gitCommonDir,
      cwd: s.cwd,
    }) !== null] as const));
    const removed = this.rules.removeByScope(scope, (rule) => this.#isRuleUnderScope(rule, scope));
    this.apply();
    const resumed: string[] = [];
    for (const session of this.registry.all()) {
      const stillPaused =
        this.rules.effectiveFor({
          sessionId: session.sessionId,
          gitCommonDir: session.gitCommonDir,
          cwd: session.cwd,
        }) !== null;
      if (before.get(session.sessionId) === true && !stillPaused) resumed.push(session.sessionId);
    }
    if (removed.length > 0) {
      this.registry.bumpRev();
      this.#bus?.publish('pause', { rules: this.rules.list(), affected: resumed });
    }
    return { removed: removed.map((r) => r.id), resumed };
  }

  deleteRule(id: string): boolean {
    const removed = this.rules.remove(id);
    if (removed === null) return false;
    const affected = this.apply();
    this.registry.bumpRev();
    this.#bus?.publish('pause', { rules: this.rules.list(), affected });
    return true;
  }

  rulesBody(): { rev: number; rules: PauseRule[] } {
    return { rev: this.registry.rev, rules: this.rules.list() };
  }
}
