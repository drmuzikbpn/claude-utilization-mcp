// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * What a session registration may contain (§23.56).
 *
 * Everything here used to be taken on trust from whoever reached the register endpoint.
 * The bearer now stands in front of it, but a token holder — a paired phone, or whoever
 * has it now — is still not a reason to accept an unbounded string, an id that walks out
 * of a directory, or a pid that is not a Claude Code session.
 */
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';

/**
 * Claude Code's `session_id` is a UUID, and it is also the name of the transcript file and
 * of the `custom-title.json` sidecar directory. Accepting exactly that shape means the id
 * can be put in a path or a log line with no further thought.
 */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/** Registered sessions held at once. A busy machine has a few dozen. */
export const MAX_SESSIONS = 256;
/** `PATH_MAX` on Linux; macOS's is smaller. */
export const MAX_PATH_CHARS = 4_096;
export const MAX_SOURCE_CHARS = 64;
export const MAX_TOOL_CHARS = 128;
/** A scope is `project:<path>` at its longest. */
export const MAX_SCOPE_CHARS = MAX_PATH_CHARS + 16;
/** Linux's `pid_max` ceiling (2^22); macOS stays under 100 000. */
export const MAX_PID = 4_194_304;
/**
 * A registered session with no trusted pid cannot be seen to exit, so it is dropped once
 * it has gone this long without a heartbeat or a tool call. A session that is merely idle
 * re-registers itself on its next prompt (§23.23).
 */
export const PIDLESS_SESSION_TTL_MS = 2 * 60 * 60_000;

/** An absolute path with no NUL and no control characters, within `MAX_PATH_CHARS`. */
export function isCleanAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_CHARS) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return isAbsolute(value);
}

/** Is `file` inside `root` (or `root` itself)? Purely lexical: nothing is touched on disk. */
export function isInside(root: string, file: string): boolean {
  const base = resolvePath(root);
  const target = resolvePath(file);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

export type FieldCheck<T> = { ok: true; value: T } | { ok: false; field: string; why: string };

function pathField(body: Record<string, unknown>, field: string): FieldCheck<string | null> {
  const v = body[field];
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, field, why: 'must be a string' };
  if (!isCleanAbsolutePath(v)) return { ok: false, field, why: `must be an absolute path of at most ${String(MAX_PATH_CHARS)} characters` };
  return { ok: true, value: v };
}

export interface CleanRegistration {
  sessionId: string;
  pid: number | null;
  cwd: string;
  transcriptPath: string | null;
  gitCommonDir: string | null;
  source: string | null;
}

/** Validate a `POST /v1/sessions/register` body. All-or-nothing: one bad field refuses it. */
export function checkRegistration(body: Record<string, unknown>): FieldCheck<CleanRegistration> {
  const sessionId = body['sessionId'];
  if (!isSessionId(sessionId)) return { ok: false, field: 'sessionId', why: 'must be a UUID, as Claude Code sends it' };

  const rawPid = body['pid'];
  let pid: number | null = null;
  if (rawPid !== undefined && rawPid !== null) {
    if (typeof rawPid !== 'number' || !Number.isInteger(rawPid) || rawPid < 2 || rawPid > MAX_PID) {
      return { ok: false, field: 'pid', why: 'must be a process id' };
    }
    pid = rawPid;
  }

  const cwd = pathField(body, 'cwd');
  if (!cwd.ok) return cwd;
  const transcriptPath = pathField(body, 'transcriptPath');
  if (!transcriptPath.ok) return transcriptPath;
  if (transcriptPath.value !== null && !transcriptPath.value.endsWith('.jsonl')) {
    return { ok: false, field: 'transcriptPath', why: 'must name a .jsonl transcript' };
  }
  const gitCommonDir = pathField(body, 'gitCommonDir');
  if (!gitCommonDir.ok) return gitCommonDir;

  const rawSource = body['source'];
  let source: string | null = null;
  if (rawSource !== undefined && rawSource !== null) {
    if (typeof rawSource !== 'string' || rawSource.length > MAX_SOURCE_CHARS || !/^[A-Za-z0-9_-]*$/.test(rawSource)) {
      return { ok: false, field: 'source', why: `must be a short word (at most ${String(MAX_SOURCE_CHARS)} characters)` };
    }
    source = rawSource.length === 0 ? null : rawSource;
  }

  return {
    ok: true,
    value: { sessionId, pid, cwd: cwd.value ?? '', transcriptPath: transcriptPath.value, gitCommonDir: gitCommonDir.value, source },
  };
}

/** A tool name as recorded by the gate: printable, bounded; anything else is dropped. */
export function cleanToolName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOOL_CHARS) return undefined;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}
