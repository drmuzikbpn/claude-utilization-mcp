import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRequest, buildHostPolicy, isLoopbackHookPost, requestPath } from '../../src/server/middleware.js';
import type { UsageServer } from '../../src/server/index.js';
import { rawJson, rawRequest } from '../helpers/raw-request.js';
import { makeHarness, startHarnessServer, TOKEN, type Harness } from './helpers.js';

let h: Harness;
let server: UsageServer;
let port: number;
let base: string;

beforeEach(async () => {
  h = makeHarness();
  const started = await startHarnessServer(h);
  server = started.server;
  port = started.port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  h.subsystem.stop();
  await server.close();
});

interface Res {
  status: number;
  body: Record<string, unknown>;
  etag: string | null;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== undefined) headers['authorization'] = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = {};
  }
  return { status: res.status, body, etag: res.headers.get('etag') };
}

function registerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'sess-1',
    pid: 4242,
    cwd: '/tmp/x/foo',
    transcriptPath: '/tmp/t/sess-1.jsonl',
    gitCommonDir: '/tmp/x/foo/.git',
    source: 'startup',
    ...over,
  };
}

describe('the loopback hook exemption (§16 + §17.1)', () => {
  const policy = buildHostPolicy([{ address: '127.0.0.1', port: 47291 }]);
  function req(over: { remote?: string; method?: string; url?: string; authorization?: string }): IncomingMessage {
    const headers: Record<string, string> = { host: '127.0.0.1:47291' };
    if (over.authorization !== undefined) headers['authorization'] = over.authorization;
    return {
      method: over.method ?? 'POST',
      url: over.url ?? '/v1/sessions/register',
      headers,
      socket: { remoteAddress: over.remote ?? '127.0.0.1' },
    } as unknown as IncomingMessage;
  }

  it('covers exactly the three hook POSTs', () => {
    expect(isLoopbackHookPost('POST', '/v1/sessions/register')).toBe(true);
    expect(isLoopbackHookPost('POST', '/v1/sessions/abc/heartbeat')).toBe(true);
    expect(isLoopbackHookPost('POST', '/v1/sessions/abc/end')).toBe(true);
    expect(isLoopbackHookPost('POST', '/v1/sessions/abc/pause')).toBe(false);
    expect(isLoopbackHookPost('POST', '/v1/pause')).toBe(false);
    expect(isLoopbackHookPost('POST', '/v1/resume')).toBe(false);
    expect(isLoopbackHookPost('GET', '/v1/sessions/register')).toBe(false);
    expect(isLoopbackHookPost('POST', '/v1/sessions/a/b/end')).toBe(false);
  });

  it('strips the query string before matching', () => {
    expect(requestPath(req({ url: '/v1/sessions/abc/heartbeat?x=1' }))).toBe('/v1/sessions/abc/heartbeat');
  });

  it('exempts them from loopback only — the tailnet still needs the token', () => {
    expect(checkRequest(req({}), policy, TOKEN).ok).toBe(true);
    const remote = checkRequest(req({ remote: '100.101.102.103' }), policy, TOKEN);
    expect(remote.ok).toBe(false);
    if (!remote.ok) {
      expect(remote.status).toBe(401);
      expect(remote.message.length).toBeGreaterThan(0);
    }
    expect(checkRequest(req({ remote: '100.101.102.103', authorization: `Bearer ${TOKEN}` }), policy, TOKEN).ok).toBe(true);
  });

  it('still requires the token for pause from loopback', () => {
    const gate = checkRequest(req({ url: '/v1/sessions/abc/pause' }), policy, TOKEN);
    expect(gate.ok).toBe(false);
  });
});

describe('GET /v1/sessions (§17.3)', () => {
  it('answers rev + sessions with a weak ETag', async () => {
    const empty = await call('/v1/sessions');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ rev: 0, sessions: [] });
    expect(empty.etag).toBe('W/"0"');
  });

  it('bumps rev on registration and honours If-None-Match', async () => {
    await call('/v1/sessions/register', { body: registerBody() });
    const listed = await call('/v1/sessions');
    expect(listed.status).toBe(200);
    const rev = listed.body['rev'] as number;
    expect(rev).toBeGreaterThan(0);
    expect(listed.etag).toBe(`W/"${rev}"`);

    const notModified = await rawRequest({
      port,
      path: '/v1/sessions',
      headers: { 'if-none-match': `W/"${rev}"` },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers['etag']).toBe(`W/"${rev}"`);

    const stale = await rawJson({ port, path: '/v1/sessions', headers: { 'if-none-match': `W/"${rev + 99}"` } });
    expect(stale.status).toBe(200);
  });

  it('rejects a write method', async () => {
    const res = await call('/v1/sessions', { method: 'PUT', token: TOKEN });
    expect(res.status).toBe(405);
    expect(String((res.body['error'] as Record<string, unknown>)['message'])).toContain('PUT');
  });
});

describe('hook endpoints (loopback, no token)', () => {
  it('registers, heartbeats and ends', async () => {
    const registered = await call('/v1/sessions/register', { body: registerBody() });
    expect(registered.status).toBe(200);
    expect(registered.body['session']).toMatchObject({
      sessionId: 'sess-1',
      pid: 4242,
      discovered: 'hook',
      project: { name: 'foo' },
    });

    const beat = await call('/v1/sessions/sess-1/heartbeat', { body: {} });
    expect(beat.status).toBe(200);
    expect(beat.body['ok']).toBe(true);
    expect(beat.body['paused']).toBe(false);

    const unknown = await call('/v1/sessions/nope/heartbeat', { body: {} });
    expect(unknown.status).toBe(404);
    expect(String((unknown.body['error'] as Record<string, unknown>)['message'])).toContain('nope');

    const ended = await call('/v1/sessions/sess-1/end', { body: {} });
    expect(ended.body).toMatchObject({ ok: true, ended: true });
    const again = await call('/v1/sessions/sess-1/end', { body: {} });
    expect(again.body).toMatchObject({ ok: true, ended: false });
  });

  it('rejects a register with no sessionId', async () => {
    const res = await call('/v1/sessions/register', { body: { pid: 1 } });
    expect(res.status).toBe(400);
    expect(String((res.body['error'] as Record<string, unknown>)['message'])).toContain('sessionId');
  });
});

describe('GET /v1/sessions/{id}/gate (§18.2, §23.13)', () => {
  it('reports not paused and records lastTool', async () => {
    await call('/v1/sessions/register', { body: registerBody() });
    const gate = await call('/v1/sessions/sess-1/gate?tool=Bash');
    expect(gate.status).toBe(200);
    expect(gate.body).toEqual({ paused: false, mode: null, ruleId: null, reason: null });

    const listed = await call('/v1/sessions');
    const first = (listed.body['sessions'] as Record<string, unknown>[])[0];
    expect((first?.['lastTool'] as Record<string, unknown>)['name']).toBe('Bash');
  });

  it('reports the effective rule while paused', async () => {
    await call('/v1/sessions/register', { body: registerBody() });
    await call('/v1/pause', { token: TOKEN, body: { scope: 'all', mode: 'soft', reason: 'dinner' } });
    const gate = await call('/v1/sessions/sess-1/gate');
    expect(gate.body).toMatchObject({ paused: true, mode: 'soft', reason: 'dinner' });
  });
});

describe('POST /v1/pause and friends (§18.4)', () => {
  it('needs the token even from loopback', async () => {
    const res = await call('/v1/pause', { body: { scope: 'all', mode: 'soft' } });
    expect(res.status).toBe(401);
    const error = res.body['error'] as Record<string, unknown>;
    expect(String(error['message']).length).toBeGreaterThan(0);
    expect(String(error['hint']).length).toBeGreaterThan(0);
  });

  it('creates a rule, lists it, and is idempotent', async () => {
    await call('/v1/sessions/register', { body: registerBody() });
    const first = await call('/v1/pause', { token: TOKEN, body: { scope: 'all', mode: 'soft', reason: 'usage-deck:1' } });
    expect(first.status).toBe(200);
    const rule = first.body['rule'] as Record<string, unknown>;
    expect(rule['scope']).toBe('all');
    expect(rule['reason']).toBe('usage-deck:1');
    expect(rule['createdBy']).toBe('dashboard');
    expect(first.body['affected']).toEqual(['sess-1']);

    const again = await call('/v1/pause', { token: TOKEN, body: { scope: 'all', mode: 'soft', reason: 'different' } });
    expect((again.body['rule'] as Record<string, unknown>)['id']).toBe(rule['id']);

    const rules = await call('/v1/pause/rules');
    expect((rules.body['rules'] as unknown[]).length).toBe(1);
    expect(rules.body['rev']).toBe(h.subsystem.registry.rev);
  });

  it('rejects an unknown scope or mode', async () => {
    const scope = await call('/v1/pause', { token: TOKEN, body: { scope: 'everything', mode: 'soft' } });
    expect(scope.status).toBe(400);
    const mode = await call('/v1/pause', { token: TOKEN, body: { scope: 'all', mode: 'frozen' } });
    expect(mode.status).toBe(400);
    expect(String((mode.body['error'] as Record<string, unknown>)['hint'])).toContain('soft');
  });

  it('resumes idempotently', async () => {
    await call('/v1/sessions/register', { body: registerBody() });
    await call('/v1/pause', { token: TOKEN, body: { scope: 'all', mode: 'soft' } });
    const first = await call('/v1/resume', { token: TOKEN, body: { scope: 'all' } });
    expect(first.status).toBe(200);
    expect((first.body['removed'] as string[]).length).toBe(1);
    expect(first.body['resumed']).toEqual(['sess-1']);

    const second = await call('/v1/resume', { token: TOKEN, body: { scope: 'all' } });
    expect(second.body).toEqual({ removed: [], resumed: [] });
  });

  it('deletes a rule by id, 404 for an unknown one', async () => {
    const created = await call('/v1/pause', { token: TOKEN, body: { scope: 'all', mode: 'soft' } });
    const id = (created.body['rule'] as Record<string, unknown>)['id'] as string;
    const res = await fetch(`${base}/v1/pause/rules/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    const missing = await call(`/v1/pause/rules/${id}`, { method: 'DELETE', token: TOKEN });
    expect(missing.status).toBe(404);
    const error = missing.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('not_found');
    expect(String(error['message'])).toContain(id);
    expect(String(error['hint']).length).toBeGreaterThan(0);
  });

  it('session sugar pauses and resumes one session', async () => {
    await call('/v1/sessions/register', { body: registerBody() });
    const paused = await call('/v1/sessions/sess-1/pause', { token: TOKEN, body: { mode: 'soft', reason: 'sugar' } });
    expect((paused.body['rule'] as Record<string, unknown>)['scope']).toBe('session:sess-1');
    expect(paused.body['affected']).toEqual(['sess-1']);

    const listed = await call('/v1/sessions');
    const session = (listed.body['sessions'] as Record<string, unknown>[])[0];
    expect(session?.['pause']).toMatchObject({ mode: 'soft', scope: 'session:sess-1', frozenPids: [] });

    const resumed = await call('/v1/sessions/sess-1/resume', { token: TOKEN, body: {} });
    expect((resumed.body['removed'] as string[]).length).toBe(1);
    expect((await call('/v1/sessions')).body['sessions']).toMatchObject([{ pause: null }]);
  });
});

describe('hard-freeze refusals (§18.3)', () => {
  it('409 for a transcript-discovered session', async () => {
    h.tokens.add('ghost', { cwd: '/tmp/x/foo' });
    const res = await call('/v1/sessions/ghost/pause', { token: TOKEN, body: { mode: 'hard' } });
    expect(res.status).toBe(409);
    const error = res.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('conflict');
    expect(String(error['message'])).toContain('transcript');
    expect((await call('/v1/pause/rules')).body['rules']).toEqual([]);
  });

  it('409 for a pid owned by another user', async () => {
    const foreign = makeHarness({ uids: { 4242: 0 } });
    const started = await startHarnessServer(foreign);
    try {
      foreign.alive.add(4242);
      foreign.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp' });
      const res = await fetch(`http://127.0.0.1:${started.port}/v1/sessions/sess-1/pause`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'hard' }),
      });
      expect(res.status).toBe(409);
      expect(foreign.subsystem.rules.list()).toEqual([]);
    } finally {
      foreign.subsystem.stop();
      await started.server.close();
    }
  });

  it('410 for an unknown session and for one whose pid is gone', async () => {
    const unknown = await call('/v1/sessions/never-seen/pause', { token: TOKEN, body: { mode: 'hard' } });
    expect(unknown.status).toBe(410);
    expect((unknown.body['error'] as Record<string, unknown>)['code']).toBe('gone');

    await call('/v1/sessions/register', { body: registerBody() });
    h.subsystem.registry.checkLiveness(); // the fake pid is not alive
    const dead = await call('/v1/sessions/sess-1/pause', { token: TOKEN, body: { mode: 'hard' } });
    expect(dead.status).toBe(410);
    expect(String((dead.body['error'] as Record<string, unknown>)['message'])).toContain('sess-1');
    expect((await call('/v1/pause/rules')).body['rules']).toEqual([]);
  });

  it('freezes the tool subprocesses, never the session itself (§23.16)', async () => {
    const live = makeHarness({
      table: [
        { pid: 4242, ppid: 1 },
        { pid: 4251, ppid: 4242 },
      ],
    });
    const started = await startHarnessServer(live);
    try {
      live.alive.add(4242);
      live.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp/x/foo' });
      const res = await fetch(`http://127.0.0.1:${started.port}/v1/sessions/sess-1/pause`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'hard', reason: 'stop now' }),
      });
      expect(res.status).toBe(200);
      // 4242 is the `claude` process: it keeps running so the user keeps their terminal.
      expect(live.signals).toEqual([{ pid: 4251, signal: 'SIGSTOP' }]);
      expect(live.subsystem.registry.get('sess-1')?.frozenPids).toEqual([4251]);
      expect(live.subsystem.registry.get('sess-1')?.freezes).toBe(1);

      live.signals.length = 0;
      await fetch(`http://127.0.0.1:${started.port}/v1/sessions/sess-1/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(live.signals).toEqual([{ pid: 4251, signal: 'SIGCONT' }]);
      expect(live.subsystem.registry.get('sess-1')?.freezes).toBe(0);
    } finally {
      live.subsystem.stop();
      await started.server.close();
    }
  });

  it('counts a second freeze after a re-register, so "frozen again" is visible (§23.16)', async () => {
    const live = makeHarness({
      table: [
        { pid: 4242, ppid: 1 },
        { pid: 4251, ppid: 4242 },
        { pid: 4390, ppid: 1 },
        { pid: 4391, ppid: 4390 },
      ],
    });
    try {
      live.alive.add(4242);
      live.alive.add(4390);
      live.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp/x/foo' });
      expect(live.subsystem.pause.pause({ scope: 'session:sess-1', mode: 'hard', createdBy: 'cli' }).ok).toBe(true);
      expect(live.subsystem.registry.get('sess-1')?.freezes).toBe(1);

      // `claude --resume`: same session id, new pid. The old tree is gone; the new one is
      // frozen, and the counter is what tells the two states apart.
      live.subsystem.registry.register({ sessionId: 'sess-1', pid: 4390, cwd: '/tmp/x/foo' });
      live.subsystem.pause.apply();
      expect(live.subsystem.registry.get('sess-1')?.frozenPids).toEqual([4391]);
      expect(live.subsystem.registry.get('sess-1')?.freezes).toBe(2);
    } finally {
      live.subsystem.stop();
    }
  });

  it('SIGCONTs a frozen tree when the session ends (§18.3)', async () => {
    const live = makeHarness({
      table: [
        { pid: 4242, ppid: 1 },
        { pid: 4251, ppid: 4242 },
      ],
    });
    const started = await startHarnessServer(live);
    try {
      live.alive.add(4242);
      live.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp/x/foo' });
      await fetch(`http://127.0.0.1:${started.port}/v1/sessions/sess-1/pause`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'hard' }),
      });
      live.signals.length = 0;

      // The SessionEnd hook posts this with no token, from loopback.
      const ended = await fetch(`http://127.0.0.1:${started.port}/v1/sessions/sess-1/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(ended.status).toBe(200);
      expect(live.signals).toEqual([{ pid: 4251, signal: 'SIGCONT' }]);
    } finally {
      live.subsystem.stop();
      await started.server.close();
    }
  });
});

describe('unknown routes under our prefixes', () => {
  it('404s with a message', async () => {
    const res = await call('/v1/sessions/a/b/c');
    expect(res.status).toBe(404);
    expect(String((res.body['error'] as Record<string, unknown>)['message']).length).toBeGreaterThan(0);
  });
});
