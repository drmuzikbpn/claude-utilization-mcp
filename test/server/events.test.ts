import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/bus.js';
import { stripRaw } from '../../src/limits/types.js';
import { createServer, type ServerOptions, type UsageServer } from '../../src/server/index.js';
import { startBusPublishers, type EventTimers, type SnapshotProvider } from '../../src/server/events.js';
import type { TokenTotals, TokensQuery, TokensResponse, TokensSource } from '../../src/server/types.js';
import { FIXTURES_DIR } from '../helpers/fixtures.js';
import { FakeTimers } from '../helpers/fake-timers.js';
import { FakeLimitsProvider, FakeTokensSource, fixtureSnapshot, snapshotWithPercents, testConfig } from '../helpers/fakes.js';

/** 2026-09-13T14:00:00.000Z — the clock every test starts from. */
const T0 = Date.parse('2026-09-13T14:00:00.000Z');
const TOKEN = 'test-bearer-token';

/** `FakeTimers` plus the interval half of the `EventTimers` contract. */
class FakeEventTimers extends FakeTimers implements EventTimers {
  private readonly intervals = new Map<number, { handle: unknown; cancelled: boolean }>();
  private nextIntervalId = 1;

  setInterval = (cb: () => void, ms: number): unknown => {
    const id = this.nextIntervalId++;
    const entry: { handle: unknown; cancelled: boolean } = { handle: null, cancelled: false };
    const arm = (): void => {
      entry.handle = this.setTimeout(() => {
        if (entry.cancelled) return;
        arm();
        cb();
      }, ms);
    };
    arm();
    this.intervals.set(id, entry);
    return id;
  };

  clearInterval = (handle: unknown): void => {
    const entry = this.intervals.get(handle as number);
    if (entry === undefined) return;
    entry.cancelled = true;
    this.clearTimeout(entry.handle);
    this.intervals.delete(handle as number);
  };
}

interface SseEvent {
  id: string | null;
  event: string;
  data: string;
  json: unknown;
}

/** An SSE client over `http.request`: parses frames and can stop reading on demand. */
class SseClient {
  readonly events: SseEvent[] = [];
  retry: number | null = null;
  status = 0;
  headers: Record<string, string> = {};
  closed = false;
  private buffer = '';
  private res: IncomingMessage | null = null;
  private req: ReturnType<typeof request> | null = null;

  static open(port: number, headers: Record<string, string> = {}): Promise<SseClient> {
    const client = new SseClient();
    return new Promise<SseClient>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/v1/events', method: 'GET', agent: false, headers },
        (res) => {
          client.res = res;
          client.status = res.statusCode ?? 0;
          for (const [k, v] of Object.entries(res.headers)) client.headers[k] = String(v);
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => client.consume(chunk));
          const markClosed = (): void => {
            client.closed = true;
          };
          res.on('close', markClosed);
          res.on('aborted', markClosed);
          res.on('error', markClosed);
          resolve(client);
        },
      );
      client.req = req;
      req.on('error', (err) => {
        client.closed = true;
        reject(err);
      });
      req.end();
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const split = this.buffer.indexOf('\n\n');
      if (split === -1) return;
      const frame = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      this.parseFrame(frame);
    }
  }

  private parseFrame(frame: string): void {
    let id: string | null = null;
    let name: string | null = null;
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry') this.retry = Number(value);
    }
    if (name === null) return;
    const text = data.join('\n');
    this.events.push({ id, event: name, data: text, json: text.length > 0 ? JSON.parse(text) : null });
  }

  /** Stop reading — the kernel receive window fills and the server sees back-pressure. */
  pause(): void {
    this.res?.pause();
  }

  resume(): void {
    this.res?.resume();
  }

  of(name: string): SseEvent[] {
    return this.events.filter((e) => e.event === name);
  }

  async waitFor(name: string, count = 1, timeoutMs = 3_000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const seen = this.of(name);
      if (seen.length >= count) return seen[count - 1] as SseEvent;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count}x "${name}" (saw ${this.events.map((e) => e.event).join(',')})`);
      await new Promise<void>((r) => setTimeout(r, 5));
    }
  }

  async waitForClose(timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the server to close the stream');
      await new Promise<void>((r) => setTimeout(r, 5));
    }
  }

  destroy(): void {
    this.req?.destroy();
    this.res?.destroy();
  }
}

/** An `EventBus` whose live-listener count tests can read, without touching the bus. */
function countingBus(): { bus: EventBus; live: () => number } {
  const bus = new EventBus();
  let live = 0;
  const original = bus.subscribe.bind(bus) as EventBus['subscribe'];
  bus.subscribe = ((name: never, listener: never) => {
    live += 1;
    const off = original(name, listener);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        live -= 1;
      }
      off();
    };
  }) as EventBus['subscribe'];
  return { bus, live: () => live };
}

const started: UsageServer[] = [];
const clients: SseClient[] = [];
let timers: FakeEventTimers;
let bus: EventBus;
let liveListeners: () => number;
let claudeJsonPath: string;

const SESSIONS: unknown[] = [
  { id: 'sess-a', pid: 4242, cwd: '/home/dev/alpha', state: 'active' },
  { id: 'sess-b', pid: 4243, cwd: '/home/dev/beta', state: 'idle' },
];
const RULES: unknown[] = [{ id: 'rule-1', scope: 'global', mode: 'soft', reason: 'usage-deck:demo' }];

const provider: SnapshotProvider = { sessions: () => SESSIONS, rules: () => RULES };

beforeEach(() => {
  timers = new FakeEventTimers();
  const counting = countingBus();
  bus = counting.bus;
  liveListeners = counting.live;
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-events-'));
  claudeJsonPath = join(dir, '.claude.json');
  writeFileSync(
    claudeJsonPath,
    JSON.stringify({
      oauthAccount: {
        emailAddress: 'dev@example.test',
        accountUuid: '00000000-0000-4000-8000-000000000001',
        organizationUuid: '00000000-0000-4000-8000-000000000002',
        displayName: 'Dev Example',
        organizationName: 'Example Org',
      },
    }),
  );
});

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.destroy();
  while (started.length > 0) {
    const s = started.pop();
    if (s !== undefined) await s.close();
  }
});

interface Started {
  server: UsageServer;
  port: number;
  url: (p: string) => string;
}

async function start(over: Partial<ServerOptions> = {}): Promise<Started> {
  const server = createServer({
    config: testConfig(),
    limits: new FakeLimitsProvider(),
    tokens: new FakeTokensSource({ totals: { input: 1_000, output: 200, cacheCreate: 10, cacheRead: 5, messages: 7 } }),
    version: '9.9.9',
    claudeJsonPath,
    now: () => T0 + timers.clock,
    bus,
    snapshots: provider,
    eventsTuning: { timers },
    ...over,
  });
  started.push(server);
  const port = await server.listen(0, '127.0.0.1');
  return { server, port, url: (p) => `http://127.0.0.1:${port}${p}` };
}

async function connect(port: number, headers?: Record<string, string>): Promise<SseClient> {
  const client = await SseClient.open(port, headers);
  clients.push(client);
  return client;
}

describe('GET /v1/events — connect', () => {
  it('sends the SSE headers and a retry hint', async () => {
    const { port } = await start();
    const client = await connect(port);
    await client.waitFor('snapshot');

    expect(client.status).toBe(200);
    expect(client.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(client.headers['cache-control']).toBe('no-store');
    expect(client.headers['x-accel-buffering']).toBe('no');
    expect(client.retry).toBe(3000);
  });

  it('sends a snapshot with the §19 shape, whatever Last-Event-ID says', async () => {
    const { port, url } = await start();
    const client = await connect(port, { 'last-event-id': '41' });
    const snapshot = await client.waitFor('snapshot');

    expect(client.events[0]?.event).toBe('snapshot');
    const body = snapshot.json as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['name', 'version', 'user', 'limits', 'summary', 'sessions', 'rules', 'update', 'rev']);
    expect(body['name']).toBe('test-host');
    expect(body['version']).toBe('9.9.9');
    expect(body['user']).toMatchObject({ emailAddress: 'dev@example.test', displayName: 'Dev Example' });
    expect(body['sessions']).toEqual(SESSIONS);
    expect(body['rules']).toEqual(RULES);
    expect(body['rev']).toBe(0);

    // `limits` is the `/v1/limits` body minus `raw`.
    expect(body['limits']).toEqual(JSON.parse(JSON.stringify(stripRaw(fixtureSnapshot()))));
    expect(Object.keys(body['limits'] as Record<string, unknown>)).not.toContain('raw');

    // `summary` is byte-for-byte the `/v1/summary` body.
    const summaryText = await (await fetch(url('/v1/summary'))).text();
    expect(JSON.stringify(body['summary'])).toBe(summaryText);

    // `update` is the `/health.update` object.
    const health = (await (await fetch(url('/health'))).json()) as Record<string, unknown>;
    expect(body['update']).toEqual(health['update']);
  });

  it('defaults sessions and rules to empty arrays without a provider', async () => {
    const { port } = await start({ snapshots: undefined });
    const client = await connect(port);
    const body = (await client.waitFor('snapshot')).json as Record<string, unknown>;
    expect(body['sessions']).toEqual([]);
    expect(body['rules']).toEqual([]);
  });

  it('answers HEAD with 200 and no body, and POST with 405', async () => {
    const { url } = await start();
    const head = await fetch(url('/v1/events'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await head.text()).toBe('');

    const post = await fetch(url('/v1/events'), { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toContain('GET');
  });
});

describe('GET /v1/events — forwarding', () => {
  it('forwards every bus event with its wire name, payload and id = rev', async () => {
    const { port } = await start();
    const client = await connect(port);
    await client.waitFor('snapshot');

    const limitsPayload = stripRaw(snapshotWithPercents({ session: 42 }));
    const limitsRev = bus.publish('limits', limitsPayload);
    const sessionRev = bus.publish('session', { type: 'start', session: SESSIONS[0] });
    const pauseRev = bus.publish('pause', { rules: RULES, affected: ['sess-a'] });
    const updateRev = bus.publish('update', { channel: 'stable', current: '9.9.9', available: '9.9.10', state: 'ready', deferredReason: null });

    const limits = await client.waitFor('limits');
    expect(limits.json).toEqual(JSON.parse(JSON.stringify(limitsPayload)));
    expect(limits.id).toBe(String(limitsRev));

    const session = await client.waitFor('session');
    expect(session.json).toEqual({ type: 'start', session: SESSIONS[0] });
    expect(session.id).toBe(String(sessionRev));

    const pause = await client.waitFor('pause');
    expect(pause.json).toEqual({ rules: RULES, affected: ['sess-a'] });
    expect(pause.id).toBe(String(pauseRev));

    const update = await client.waitFor('update');
    expect((update.json as Record<string, unknown>)['state']).toBe('ready');
    expect(update.id).toBe(String(updateRev));
  });

  it('fans one publish out to every connected client', async () => {
    const { port } = await start();
    const a = await connect(port);
    const b = await connect(port);
    await a.waitFor('snapshot');
    await b.waitFor('snapshot');

    bus.publish('session', { type: 'end', session: SESSIONS[1] });
    expect((await a.waitFor('session')).json).toEqual({ type: 'end', session: SESSIONS[1] });
    expect((await b.waitFor('session')).json).toEqual({ type: 'end', session: SESSIONS[1] });
  });

  it('coalesces spend to one event per second with a cumulative delta', async () => {
    const { port } = await start();
    const client = await connect(port);
    await client.waitFor('snapshot');

    for (let i = 0; i < 5; i++) {
      bus.publish('spend', {
        today: { ready: true, input: 100 * (i + 1), output: 0, cacheCreate: 0, cacheRead: 0, messages: i + 1 },
        delta: { input: 100, output: 0, cacheCreate: 0, cacheRead: 0, messages: 1 },
      });
      await timers.advance(50);
    }
    expect(client.of('spend')).toHaveLength(0);

    await timers.advance(1_000);
    const spend = await client.waitFor('spend');
    expect(client.of('spend')).toHaveLength(1);
    expect(spend.json).toEqual({
      // `today` is the newest reading; `delta` accumulates everything coalesced away.
      today: { ready: true, input: 500, output: 0, cacheCreate: 0, cacheRead: 0, messages: 5 },
      delta: { input: 500, output: 0, cacheCreate: 0, cacheRead: 0, messages: 5 },
    });
  });

  it('emits a heartbeat every 15 s', async () => {
    const { port } = await start();
    const client = await connect(port);
    await client.waitFor('snapshot');

    await timers.advance(14_000);
    expect(client.of('heartbeat')).toHaveLength(0);

    await timers.advance(1_000);
    const first = await client.waitFor('heartbeat');
    expect(first.json).toEqual({ rev: 0, at: new Date(T0 + 15_000).toISOString() });

    bus.publish('update', { state: 'idle' });
    await client.waitFor('update');
    await timers.advance(15_000);
    const second = await client.waitFor('heartbeat', 2);
    expect(second.json).toEqual({ rev: 1, at: new Date(T0 + 30_000).toISOString() });
    expect(second.id).toBe('1');
  });
});

describe('GET /v1/events — limits and lifecycle', () => {
  it('refuses more than config.events.maxClients streams with a 503 envelope', async () => {
    const { port, url } = await start({ config: testConfig({ events: { maxClients: 2 } }) });
    const a = await connect(port);
    const b = await connect(port);
    await a.waitFor('snapshot');
    await b.waitFor('snapshot');

    const res = await fetch(url('/v1/events'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string; hint?: string } };
    expect(body.error.code).toBe('unavailable');
    expect(body.error.message.length).toBeGreaterThan(0);

    // A freed slot is reusable.
    a.destroy();
    await new Promise<void>((r) => setTimeout(r, 50));
    const c = await connect(port);
    expect((await c.waitFor('snapshot')).event).toBe('snapshot');
  });

  it('destroys a client that stays backed up for more than 30 s', async () => {
    const { server, port } = await start();
    const slow = await connect(port);
    await slow.waitFor('snapshot');

    slow.pause();
    // Far more than loopback socket buffers can absorb on any platform (Linux autotunes
    // send+receive buffers to several MB each): the writes cannot drain while paused.
    for (let i = 0; i < 8; i += 1) {
      bus.publish('session', { type: 'update', session: { id: `sess-${String(i)}`, blob: 'x'.repeat(8 * 1024 * 1024) } });
    }
    await new Promise<void>((r) => setTimeout(r, 100));

    await timers.advance(29_000);
    expect(server.events.clientCount).toBe(1);

    await timers.advance(2_000);
    expect(server.events.clientCount).toBe(0);
    // A paused client only observes the destroyed socket once it reads again.
    slow.resume();
    await slow.waitForClose();
  });

  it('unsubscribes from the bus when a client disconnects', async () => {
    const { port } = await start();
    const baseline = liveListeners();
    const client = await connect(port);
    await client.waitFor('snapshot');
    expect(liveListeners()).toBeGreaterThan(baseline);

    client.destroy();
    const deadline = Date.now() + 2_000;
    while (liveListeners() !== baseline && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 5));
    expect(liveListeners()).toBe(baseline);
  });

  it('drops every stream and its timers on server close', async () => {
    const { server, port } = await start();
    const client = await connect(port);
    await client.waitFor('snapshot');
    await server.close();
    started.pop();
    await client.waitForClose();
    expect(timers.pendingCount).toBe(0);
  });
});

describe('GET /v1/events — auth', () => {
  /**
   * Loopback is read from the socket's remote address, which a test cannot spoof over
   * TCP, so the gate is exercised through `server.handle` with a synthetic request —
   * the same technique as `test/server-middleware.test.ts`.
   */
  function fakeReq(port: number, over: { remote?: string; headers?: Record<string, string> } = {}): IncomingMessage {
    return {
      method: 'GET',
      url: '/v1/events',
      headers: { host: `127.0.0.1:${port}`, ...over.headers },
      socket: { remoteAddress: over.remote ?? '100.64.0.9', setTimeout: () => undefined, setNoDelay: () => undefined },
      on: () => undefined,
      once: () => undefined,
    } as unknown as IncomingMessage;
  }

  interface CapturedRes {
    status: number;
    headers: Record<string, unknown>;
    chunks: string[];
    res: import('node:http').ServerResponse;
  }

  function fakeRes(): CapturedRes {
    const captured: CapturedRes = { status: 0, headers: {}, chunks: [], res: null as never };
    const listeners = new Map<string, Array<() => void>>();
    const res = {
      writableEnded: false,
      writableLength: 0,
      headersSent: false,
      writeHead(status: number, headers?: Record<string, unknown>) {
        captured.status = status;
        Object.assign(captured.headers, headers ?? {});
        this.headersSent = true;
        return this;
      },
      setHeader(k: string, v: unknown) {
        captured.headers[k] = v;
      },
      flushHeaders() {
        /* no-op */
      },
      write(chunk: string) {
        captured.chunks.push(chunk);
        return true;
      },
      end(chunk?: string) {
        if (typeof chunk === 'string') captured.chunks.push(chunk);
        this.writableEnded = true;
      },
      destroy() {
        this.writableEnded = true;
      },
      on(event: string, cb: () => void) {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return this;
      },
      once(event: string, cb: () => void) {
        return this.on(event, cb);
      },
      removeListener() {
        return this;
      },
      emit(event: string) {
        for (const cb of listeners.get(event) ?? []) cb();
        return true;
      },
    };
    captured.res = res as unknown as import('node:http').ServerResponse;
    return captured;
  }

  it('rejects a non-loopback stream without a bearer token', async () => {
    const { server, port } = await start();
    const out = fakeRes();
    server.handle(fakeReq(port), out.res);
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(out.status).toBe(401);
    const body = JSON.parse(out.chunks.join('')) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('accepts a non-loopback stream carrying the bearer token', async () => {
    const { server, port } = await start();
    const out = fakeRes();
    server.handle(fakeReq(port, { headers: { authorization: `Bearer ${TOKEN}` } }), out.res);
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(out.chunks.join('')).toContain('event: snapshot');
    out.res.emit('close');
  });
});

describe('SSE fixtures for the dashboard client', () => {
  const dir = join(FIXTURES_DIR, 'events');

  it('stream.sse is a well-formed transcript of the documented event order', () => {
    const text = readFileSync(join(dir, 'stream.sse'), 'utf8');
    expect(text.startsWith('retry: 3000\n\n')).toBe(true);
    const frames = text
      .split('\n\n')
      .filter((f) => f.length > 0)
      .slice(1);
    const names: string[] = [];
    for (const frame of frames) {
      const id = /^id: (\d+)$/m.exec(frame);
      const name = /^event: ([a-z]+)$/m.exec(frame);
      const data = /^data: (.*)$/m.exec(frame);
      expect(id, frame).not.toBeNull();
      expect(name, frame).not.toBeNull();
      expect(data, frame).not.toBeNull();
      expect(() => JSON.parse((data as RegExpExecArray)[1] as string)).not.toThrow();
      names.push((name as RegExpExecArray)[1] as string);
    }
    // Captured from a live daemon: a session was registered and soft-paused before the client
    // connected, then resumed and heartbeated; the poller did not change during the capture.
    expect(names[0]).toBe('snapshot');
    expect(names[names.length - 1]).toBe('heartbeat');
    expect(names).toEqual(['snapshot', 'pause', 'session', 'spend', 'spend', 'heartbeat']);
  });

  it('snapshot.json is exactly the data of the transcript’s snapshot frame', () => {
    const text = readFileSync(join(dir, 'stream.sse'), 'utf8');
    const frame = text.split('\n\n').find((f) => f.includes('event: snapshot')) as string;
    const data = /^data: (.*)$/m.exec(frame) as RegExpExecArray;
    const inline = JSON.parse(data[1] as string) as Record<string, unknown>;
    const standalone = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as Record<string, unknown>;
    expect(inline).toEqual(standalone);
    expect(Object.keys(standalone)).toEqual(['name', 'version', 'user', 'limits', 'summary', 'sessions', 'rules', 'update', 'rev']);
  });
});

describe('bus publishers (what the daemon wires up)', () => {
  /** `FakeTokensSource` freezes its totals; the publisher needs them to move. */
  class MovingTokensSource implements TokensSource {
    ready = true;
    stats = { filesTracked: 1, eventsIndexed: 1, parseErrors: 0, lastScanAt: null };
    totals: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0 };
    private readonly listeners = new Set<() => void>();
    query(q: TokensQuery): TokensResponse {
      return { ready: true, stale: false, since: q.since, groupBy: q.groupBy, totals: this.totals, groups: [] };
    }
    sessionTotals(): TokenTotals | null {
      return null;
    }
    sessionModel(): string | null {
      return null;
    }
    sessionStartedAt(): string | null {
      return null;
    }
    onChange(cb: () => void): () => void {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }
    emit(): void {
      for (const cb of this.listeners) cb();
    }
  }

  function collect(name: 'limits' | 'spend'): unknown[] {
    const seen: unknown[] = [];
    bus.subscribe(name, (payload) => seen.push(payload));
    return seen;
  }

  it('publishes limits only when the sampled snapshot changed, minus raw', async () => {
    const limits = new FakeLimitsProvider();
    const seen = collect('limits');
    const stop = startBusPublishers({ bus, limits, tokens: () => null, timers, now: () => T0 + timers.clock });

    await timers.advance(1_000);
    expect(seen).toHaveLength(0);

    limits.set(snapshotWithPercents({ session: 77 }));
    await timers.advance(1_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(stripRaw(snapshotWithPercents({ session: 77 })));
    expect(Object.keys(seen[0] as Record<string, unknown>)).not.toContain('raw');

    // An unchanged snapshot is not news.
    await timers.advance(5_000);
    expect(seen).toHaveLength(1);

    stop();
    expect(timers.pendingCount).toBe(0);
  });

  it('publishes machine-wide spend at most once per second, delta since the last one', async () => {
    const tokens = new MovingTokensSource();
    const seen = collect('spend');
    const stop = startBusPublishers({ bus, limits: new FakeLimitsProvider(), tokens: () => tokens, timers, now: () => T0 + timers.clock });

    tokens.totals = { input: 100, output: 10, cacheCreate: 0, cacheRead: 0, messages: 1 };
    tokens.emit();
    tokens.emit();
    tokens.emit();
    expect(seen).toHaveLength(0);

    await timers.advance(1_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      today: { ready: true, input: 100, output: 10, cacheCreate: 0, cacheRead: 0, messages: 1 },
      delta: { input: 100, output: 10, cacheCreate: 0, cacheRead: 0, messages: 1 },
    });

    tokens.totals = { input: 250, output: 25, cacheCreate: 0, cacheRead: 0, messages: 3 };
    tokens.emit();
    await timers.advance(1_000);
    expect(seen).toHaveLength(2);
    expect((seen[1] as { delta: TokenTotals }).delta).toEqual({ input: 150, output: 15, cacheCreate: 0, cacheRead: 0, messages: 2 });

    // A change that did not move today's totals publishes nothing.
    tokens.emit();
    await timers.advance(1_000);
    expect(seen).toHaveLength(2);

    stop();
    tokens.emit();
    await timers.advance(2_000);
    expect(seen).toHaveLength(2);
  });
});

describe('bus publishers observe the poller instead of sampling it (§19)', () => {
  it('publishes the moment the poller reports a change, with no timer tick', async () => {
    const limits = new FakeLimitsProvider();
    const seen: unknown[] = [];
    bus.subscribe('limits', (payload) => seen.push(payload));
    const stop = startBusPublishers({ bus, limits, tokens: () => null, timers, now: () => T0 + timers.clock });

    limits.set(snapshotWithPercents({ session: 77 }));
    // No `timers.advance` — a sampling publisher would still be waiting for its interval.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(stripRaw(snapshotWithPercents({ session: 77 })));

    stop();
  });

  it('schedules no polling timers at all', async () => {
    const stop = startBusPublishers({
      bus,
      limits: new FakeLimitsProvider(),
      tokens: () => null,
      timers,
      now: () => T0 + timers.clock,
    });
    expect(timers.pendingCount).toBe(0);
    await timers.advance(60_000);
    expect(timers.pendingCount).toBe(0);
    stop();
  });

  it('publishes nothing for a snapshot that changed without a notification', async () => {
    const limits = new FakeLimitsProvider();
    const seen: unknown[] = [];
    bus.subscribe('limits', (payload) => seen.push(payload));
    const stop = startBusPublishers({ bus, limits, tokens: () => null, timers, now: () => T0 + timers.clock });

    // The real poller only notifies when the normalized body moved; silence means silence.
    await timers.advance(10_000);
    expect(seen).toHaveLength(0);
    stop();
  });

  it('unsubscribes from the poller on stop', () => {
    const limits = new FakeLimitsProvider();
    const seen: unknown[] = [];
    bus.subscribe('limits', (payload) => seen.push(payload));
    const stop = startBusPublishers({ bus, limits, tokens: () => null, timers, now: () => T0 + timers.clock });

    limits.set(snapshotWithPercents({ session: 51 }));
    stop();
    limits.set(snapshotWithPercents({ session: 52 }));
    expect(seen).toHaveLength(1);
  });

  it('drives the SSE `limits` event end to end from a poller change', async () => {
    const limits = new FakeLimitsProvider();
    const { port } = await start({ limits });
    const stop = startBusPublishers({ bus, limits, tokens: () => null, timers, now: () => T0 + timers.clock });
    const client = await connect(port);
    await client.waitFor('snapshot');

    limits.set(snapshotWithPercents({ session: 64 }));
    const event = await client.waitFor('limits');
    expect((event.json as { limits: Array<{ id: string; percent: number }> }).limits[0]).toMatchObject({
      id: 'session',
      percent: 64,
    });
    stop();
  });
});
