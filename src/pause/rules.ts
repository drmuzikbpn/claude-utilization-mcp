/**
 * Pause rules (§18.1) — rules, not flags.
 *
 * A session's effective pause is the most specific matching rule (session > project > all);
 * `hard` beats `soft` at the same specificity. Rules are persisted in
 * `<configDir>/pause.json` (0600, atomic) and therefore apply to sessions that register
 * *after* the rule was created.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../config.js';
import { mainWorktreeOf } from '../sessions/registry.js';
import type { PauseMode, PauseTarget } from '../sessions/types.js';

export const PAUSE_FILE = 'pause.json';
export const PAUSE_FILE_VERSION = 1;
/** §23.13: `reason` is echoed verbatim, trimmed to 200 chars. */
export const REASON_MAX_CHARS = 200;

export type CreatedBy = 'dashboard' | 'cli';

export interface PauseRule {
  id: string;
  /** `all` | `project:<gitCommonDir>` | `session:<sessionId>`. */
  scope: string;
  mode: PauseMode;
  reason: string;
  createdAt: string;
  createdBy: CreatedBy;
}

export function pauseFilePath(configDir: string): string {
  return join(configDir, PAUSE_FILE);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `r_` + 16 random base32 chars (§18.1 `id`). */
export function newRuleId(rand: (n: number) => Buffer = randomBytes): string {
  const bytes = rand(16);
  let out = 'r_';
  for (const b of bytes) out += BASE32[b % 32];
  return out;
}

export type ParsedScope =
  | { kind: 'all' }
  | { kind: 'project'; value: string }
  | { kind: 'session'; value: string };

export function parseScope(scope: unknown): ParsedScope | null {
  if (typeof scope !== 'string') return null;
  const s = scope.trim();
  if (s === 'all') return { kind: 'all' };
  if (s.startsWith('project:')) {
    const value = s.slice('project:'.length);
    return value.length === 0 ? null : { kind: 'project', value: value.replace(/\/$/, '') };
  }
  if (s.startsWith('session:')) {
    const value = s.slice('session:'.length);
    return value.length === 0 ? null : { kind: 'session', value };
  }
  return null;
}

export function isPauseMode(v: unknown): v is PauseMode {
  return v === 'soft' || v === 'hard';
}

/** Verbatim, capped at 200 chars (§23.13). Never `undefined` on the wire. */
export function normalizeReason(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  return reason.slice(0, REASON_MAX_CHARS);
}

const SPECIFICITY: Record<ParsedScope['kind'], number> = { all: 1, project: 2, session: 3 };

/**
 * Does `rule` apply to `target`?
 *
 * A `project:` scope is matched against the session's `gitCommonDir`, against the main
 * worktree directory (what a human types on the CLI: `pause project:/Users/me/code/foo`),
 * and — for sessions outside a repo — against `cwd`.
 */
export function ruleMatches(rule: PauseRule, target: PauseTarget): boolean {
  const scope = parseScope(rule.scope);
  if (scope === null) return false;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'session') return scope.value === target.sessionId;
  const cwd = target.cwd.replace(/\/$/, '');
  if (target.gitCommonDir === null) return scope.value === cwd;
  if (scope.value === target.gitCommonDir.replace(/\/$/, '')) return true;
  if (scope.value === mainWorktreeOf(target.gitCommonDir)) return true;
  return scope.value === cwd;
}

/** §18.1: session > project > all; `hard` beats `soft` at equal specificity. */
export function pickEffective(rules: readonly PauseRule[], target: PauseTarget): PauseRule | null {
  let best: { rule: PauseRule; spec: number; hard: number } | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, target)) continue;
    const parsed = parseScope(rule.scope);
    if (parsed === null) continue;
    const spec = SPECIFICITY[parsed.kind];
    const hard = rule.mode === 'hard' ? 1 : 0;
    if (
      best === null ||
      spec > best.spec ||
      (spec === best.spec && hard > best.hard) ||
      (spec === best.spec && hard === best.hard && rule.createdAt < best.rule.createdAt)
    ) {
      best = { rule, spec, hard };
    }
  }
  return best === null ? null : best.rule;
}

interface PersistedRules {
  version?: number;
  rules?: PauseRule[];
}

export interface PauseRuleStoreOptions {
  configDir: string;
  now?: () => number;
  makeId?: () => string;
}

export class PauseRuleStore {
  readonly configDir: string;
  #rules: PauseRule[] = [];
  #now: () => number;
  #makeId: () => string;

  constructor(opts: PauseRuleStoreOptions) {
    this.configDir = opts.configDir;
    this.#now = opts.now ?? Date.now;
    this.#makeId = opts.makeId ?? ((): string => newRuleId());
  }

  load(): void {
    let parsed: PersistedRules;
    try {
      parsed = JSON.parse(readFileSync(pauseFilePath(this.configDir), 'utf8')) as PersistedRules;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.rules)) return;
    this.#rules = parsed.rules.filter(
      (r): r is PauseRule =>
        typeof r?.id === 'string' && typeof r.scope === 'string' && isPauseMode(r.mode) && parseScope(r.scope) !== null,
    );
  }

  save(): void {
    try {
      writeJsonFile(pauseFilePath(this.configDir), { version: PAUSE_FILE_VERSION, rules: this.#rules });
    } catch {
      // best effort
    }
  }

  list(): PauseRule[] {
    return [...this.#rules];
  }

  find(id: string): PauseRule | null {
    return this.#rules.find((r) => r.id === id) ?? null;
  }

  /** §18.1: the same `(scope, mode)` posted twice returns the existing rule. */
  add(input: { scope: string; mode: PauseMode; reason?: string | undefined; createdBy: CreatedBy }): {
    rule: PauseRule;
    created: boolean;
  } {
    const existing = this.#rules.find((r) => r.scope === input.scope && r.mode === input.mode);
    if (existing !== undefined) return { rule: existing, created: false };
    const rule: PauseRule = {
      id: this.#makeId(),
      scope: input.scope,
      mode: input.mode,
      reason: normalizeReason(input.reason),
      createdAt: new Date(this.#now()).toISOString(),
      createdBy: input.createdBy,
    };
    this.#rules.push(rule);
    this.save();
    return { rule, created: true };
  }

  remove(id: string): PauseRule | null {
    const i = this.#rules.findIndex((r) => r.id === id);
    if (i === -1) return null;
    const [removed] = this.#rules.splice(i, 1);
    this.save();
    return removed ?? null;
  }

  /** Every rule whose scope string matches exactly — what `POST /v1/resume { scope }` clears. */
  removeByScope(scope: string): PauseRule[] {
    const removed = this.#rules.filter((r) => r.scope === scope);
    if (removed.length === 0) return [];
    this.#rules = this.#rules.filter((r) => r.scope !== scope);
    this.save();
    return removed;
  }

  clear(): PauseRule[] {
    const removed = this.#rules;
    this.#rules = [];
    this.save();
    return removed;
  }

  effectiveFor(target: PauseTarget): PauseRule | null {
    return pickEffective(this.#rules, target);
  }
}
