/**
 * The §18.4 endpoint surface. Registered by `createServer` as one block so the rest of the
 * server file stays untouched; every route's real work lives in `src/sessions` / `src/pause`.
 *
 * Auth: the generic gate in `src/server/middleware.ts` has already run. Mutating requests
 * therefore carry the bearer token — except the three loopback hook endpoints called by
 * `claude-usage hook`, which are exempted there (see `LOOPBACK_HOOK_POSTS`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson } from '../server/errors.js';
import { isPauseMode, parseScope, type CreatedBy } from '../pause/rules.js';
import type { PauseController } from '../pause/controller.js';
import type { SessionRegistry } from './registry.js';
import type { RegisterInput } from './types.js';

export const MAX_BODY_BYTES = 64 * 1024;

export interface SessionsApi {
  registry: SessionRegistry;
  pause: PauseController;
}

/** Read a JSON request body; `{}` for an empty body, `null` when it is not a JSON object. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function str(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === 'string' ? v : undefined;
}

function methodNotAllowed(res: ServerResponse, method: string, path: string, allowed: string[]): void {
  res.setHeader('allow', allowed.join(', '));
  sendError(res, 405, 'method_not_allowed', `${method} is not allowed on ${path}`, `allowed: ${allowed.join(', ')}`);
}

export interface SessionsRouter {
  /** `true` when the path belongs to this router (the response has been sent). */
  handle(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL): Promise<boolean>;
}

export function createSessionsRouter(api: SessionsApi): SessionsRouter {
  const { registry, pause } = api;

  function sessionsBody(): { rev: number; sessions: unknown[] } {
    return { rev: registry.rev, sessions: registry.list() };
  }

  /** `POST /v1/pause` and its `/v1/sessions/{id}/pause` sugar share this. */
  function doPause(
    res: ServerResponse,
    body: Record<string, unknown>,
    scope: string,
    createdBy: CreatedBy,
  ): void {
    const mode = body['mode'] ?? 'soft';
    if (!isPauseMode(mode)) {
      sendError(res, 400, 'bad_request', 'invalid "mode"', 'mode must be "soft" or "hard"');
      return;
    }
    if (parseScope(scope) === null) {
      sendError(res, 400, 'bad_request', `invalid "scope": ${scope}`, 'scope must be "all", "project:<path>" or "session:<id>"');
      return;
    }
    const reason = str(body, 'reason');
    const outcome = pause.pause({ scope, mode, reason, createdBy });
    if (!outcome.ok) {
      sendError(res, outcome.status, outcome.code, outcome.message, outcome.hint);
      return;
    }
    sendJson(res, 200, { rule: outcome.rule, affected: outcome.affected });
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    url: URL,
  ): Promise<boolean> {
    const parts = path.split('/').filter((p) => p.length > 0);
    if (parts[0] !== 'v1') return false;
    const createdBy: CreatedBy = req.headers.authorization === undefined ? 'cli' : 'dashboard';

    // ---- /v1/sessions ------------------------------------------------------
    if (parts[1] === 'sessions') {
      if (parts.length === 2) {
        if (method !== 'GET' && method !== 'HEAD') {
          methodNotAllowed(res, method, path, ['GET', 'HEAD']);
          return true;
        }
        const etag = `W/"${registry.rev}"`;
        const inm = req.headers['if-none-match'];
        if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === etag)) {
          res.writeHead(304, { etag, 'cache-control': 'no-store' });
          res.end();
          return true;
        }
        res.setHeader('etag', etag);
        sendJson(res, 200, sessionsBody());
        return true;
      }

      if (parts.length === 3 && parts[2] === 'register') {
        if (method !== 'POST') {
          methodNotAllowed(res, method, path, ['POST']);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'bad_request', 'body must be a JSON object', 'see §17.1 for the register payload');
          return true;
        }
        const sessionId = str(body, 'sessionId');
        if (sessionId === undefined || sessionId.length === 0) {
          sendError(res, 400, 'bad_request', '"sessionId" is required', 'the SessionStart hook sends Claude Code\'s session_id');
          return true;
        }
        const pid = body['pid'];
        const input: RegisterInput = {
          sessionId,
          pid: typeof pid === 'number' ? pid : null,
          cwd: str(body, 'cwd') ?? '',
          transcriptPath: str(body, 'transcriptPath') ?? null,
          gitCommonDir: str(body, 'gitCommonDir') ?? null,
          source: str(body, 'source') ?? null,
        };
        registry.register(input);
        // A rule created before this session existed applies to it (§18.1).
        pause.apply();
        const view = registry.viewOf(sessionId);
        sendJson(res, 200, { session: view, rev: registry.rev });
        return true;
      }

      if (parts.length === 4) {
        const id = parts[2] as string;
        const action = parts[3];

        if (action === 'gate') {
          if (method !== 'GET' && method !== 'HEAD') {
            methodNotAllowed(res, method, path, ['GET', 'HEAD']);
            return true;
          }
          const tool = url.searchParams.get('tool');
          sendJson(res, 200, pause.gate(id, tool === null ? undefined : tool));
          return true;
        }

        if (action === 'heartbeat' || action === 'end' || action === 'pause' || action === 'resume') {
          if (method !== 'POST') {
            methodNotAllowed(res, method, path, ['POST']);
            return true;
          }
          const body = await readJsonBody(req);
          if (body === null) {
            sendError(res, 400, 'bad_request', 'body must be a JSON object');
            return true;
          }
          if (action === 'heartbeat') {
            const session = registry.heartbeat(id);
            if (session === null) {
              sendError(res, 404, 'not_found', `unknown session ${id}`, 'the SessionStart hook registers sessions');
              return true;
            }
            sendJson(res, 200, { ok: true, rev: registry.rev, ...pause.gate(id) });
            return true;
          }
          if (action === 'end') {
            const ended = registry.end(id);
            if (ended !== null) {
              // A session that ends while hard-frozen must not leave stopped processes.
              pause.thawSession(ended);
              pause.apply();
            }
            // Ending is idempotent: a hook must never see an error it cannot act on.
            sendJson(res, 200, { ok: true, ended: ended !== null, rev: registry.rev });
            return true;
          }
          if (action === 'pause') {
            doPause(res, body, `session:${id}`, createdBy);
            return true;
          }
          const result = pause.resume(`session:${id}`);
          sendJson(res, 200, result);
          return true;
        }
      }

      sendError(res, 404, 'not_found', `no route for ${path}`);
      return true;
    }

    // ---- /v1/pause, /v1/pause/rules, /v1/resume ----------------------------
    if (parts[1] === 'pause') {
      if (parts.length === 2) {
        if (method !== 'POST') {
          methodNotAllowed(res, method, path, ['POST']);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'bad_request', 'body must be a JSON object');
          return true;
        }
        const scope = str(body, 'scope');
        if (scope === undefined) {
          sendError(res, 400, 'bad_request', '"scope" is required', 'scope must be "all", "project:<path>" or "session:<id>"');
          return true;
        }
        doPause(res, body, scope, createdBy);
        return true;
      }

      if (parts[2] === 'rules' && parts.length === 3) {
        if (method !== 'GET' && method !== 'HEAD') {
          methodNotAllowed(res, method, path, ['GET', 'HEAD']);
          return true;
        }
        sendJson(res, 200, pause.rulesBody());
        return true;
      }

      if (parts[2] === 'rules' && parts.length === 4) {
        if (method !== 'DELETE') {
          methodNotAllowed(res, method, path, ['DELETE']);
          return true;
        }
        const id = parts[3] as string;
        if (!pause.deleteRule(id)) {
          sendError(res, 404, 'not_found', `unknown rule ${id}`, 'list the live rules with GET /v1/pause/rules');
          return true;
        }
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return true;
      }

      sendError(res, 404, 'not_found', `no route for ${path}`);
      return true;
    }

    if (parts[1] === 'resume' && parts.length === 2) {
      if (method !== 'POST') {
        methodNotAllowed(res, method, path, ['POST']);
        return true;
      }
      const body = await readJsonBody(req);
      if (body === null) {
        sendError(res, 400, 'bad_request', 'body must be a JSON object');
        return true;
      }
      const scope = str(body, 'scope');
      if (scope === undefined || parseScope(scope) === null) {
        sendError(res, 400, 'bad_request', 'invalid "scope"', 'scope must be "all", "project:<path>" or "session:<id>"');
        return true;
      }
      sendJson(res, 200, pause.resume(scope));
      return true;
    }

    return false;
  }

  return { handle };
}
