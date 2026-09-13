import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import type { UpdateStatus } from '../../src/server/snapshot.js';
import type { UpdaterHandle } from '../../src/update/index.js';
import { FakeTokensSource } from '../helpers/fakes.js';
import { tempConfigDir } from '../helpers/fake-daemon.js';

const handles: DaemonHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.stop();
});

/** A stand-in updater that records the lifecycle calls the daemon makes. */
function fakeUpdater(initial: Partial<UpdateStatus> = {}): UpdaterHandle & { started: number; stopped: number; state: UpdateStatus } {
  const state: UpdateStatus = {
    channel: 'stable',
    current: '9.9.9',
    available: null,
    state: 'idle',
    deferredReason: null,
    ...initial,
  };
  const calls = { started: 0, stopped: 0 };
  return {
    state,
    get started() {
      return calls.started;
    },
    get stopped() {
      return calls.stopped;
    },
    status: () => state,
    start: () => {
      calls.started += 1;
    },
    stop: () => {
      calls.stopped += 1;
    },
    runOnce: () => Promise.resolve(state),
    checkOnly: () => Promise.resolve({ current: state.current, available: state.available, error: null }),
    pendingDelayMs: null,
  };
}

async function start(updater?: UpdaterHandle | null): Promise<DaemonHandle> {
  const h = await startDaemon({
    configDir: tempConfigDir(),
    port: 0,
    poll: false,
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    log: () => undefined,
    ...(updater === undefined ? {} : { updater }),
  });
  handles.push(h);
  return h;
}

async function health(h: DaemonHandle): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${h.port}/health`);
  return (await res.json()) as Record<string, unknown>;
}

describe('daemon ↔ updater wiring (§15, §20)', () => {
  it('starts the updater and serves its live state on /health', async () => {
    const updater = fakeUpdater();
    const h = await start(updater);
    expect(updater.started).toBe(1);
    expect(h.updater).toBe(updater);
    await expect(health(h)).resolves.toMatchObject({ update: { state: 'idle', current: '9.9.9' } });

    updater.state.state = 'deferred';
    updater.state.deferredReason = 'hard_frozen_sessions';
    updater.state.available = '9.9.10+abc';
    await expect(health(h)).resolves.toMatchObject({
      update: { state: 'deferred', deferredReason: 'hard_frozen_sessions', available: '9.9.10+abc' },
    });
  });

  it('stops the updater on shutdown', async () => {
    const updater = fakeUpdater();
    const h = await start(updater);
    await h.stop();
    expect(updater.stopped).toBe(1);
  });

  it('updater: null leaves /health.update disabled', async () => {
    const h = await start(null);
    expect(h.updater).toBeNull();
    await expect(health(h)).resolves.toMatchObject({ update: { state: 'disabled', available: null } });
  });

  it('the real updater disables itself when the daemon is not running under `current`', async () => {
    const h = await start();
    // The test process is a git checkout, never `<data>/claude-usage/current`.
    expect(h.updater?.status()).toMatchObject({ state: 'disabled', deferredReason: 'not_installed' });
    expect(h.updater?.pendingDelayMs).toBeNull();
    await expect(health(h)).resolves.toMatchObject({ update: { state: 'disabled' } });
  });

  it('the SSE snapshot embeds the same live update object (§19)', async () => {
    const updater = fakeUpdater({ state: 'downloading', available: '9.9.10+abc' });
    const h = await start(updater);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/events`, { headers: { accept: 'text/event-stream' } });
    const body = res.body;
    if (body === null) throw new Error('no SSE body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let frame: RegExpExecArray | null = null;
    // The stream opens with a `retry:` frame, so read on until the snapshot arrives.
    while (frame === null) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
      frame = /event: snapshot\ndata: (.*)\n\n/.exec(text);
    }
    await reader.cancel();
    const data = frame?.[1] ?? '{}';
    expect((JSON.parse(data) as Record<string, unknown>)['update']).toEqual(updater.status());
  });
});
