import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type UsageServer } from '../../src/server/index.js';
import { updateBody, type UpdateStatus } from '../../src/server/snapshot.js';
import { EmptyLimitsProvider, testConfig } from '../helpers/fakes.js';

const started: UsageServer[] = [];
afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return { channel: 'stable', current: '9.9.9', available: null, state: 'idle', deferredReason: null, ...over };
}

async function health(update?: () => UpdateStatus): Promise<Record<string, unknown>> {
  const server = createServer({
    config: testConfig(),
    limits: new EmptyLimitsProvider(),
    version: '9.9.9',
    ...(update === undefined ? {} : { update }),
  });
  started.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return (await res.json()) as Record<string, unknown>;
}

describe('/health.update (§15, §20)', () => {
  it('reports the injected updater state verbatim', async () => {
    const body = await health(() => status({ available: '9.9.10+abc', state: 'ready' }));
    expect(body['update']).toEqual({
      channel: 'stable',
      current: '9.9.9',
      available: '9.9.10+abc',
      state: 'ready',
      deferredReason: null,
    });
  });

  it.each([
    ['idle', null, null],
    ['checking', null, null],
    ['downloading', '9.9.10+abc', null],
    ['verifying', '9.9.10+abc', null],
    ['ready', '9.9.10+abc', null],
    ['deferred', '9.9.10+abc', 'hard_frozen_sessions'],
    ['disabled', null, 'disabled_by_config'],
    ['error', '9.9.10+abc', null],
  ] as const)('serialises state %s', async (state, available, reason) => {
    const body = await health(() => status({ state, available, deferredReason: reason }));
    expect(body['update']).toEqual({
      channel: 'stable',
      current: '9.9.9',
      available,
      state,
      deferredReason: reason,
    });
    // The key order is stable for dashboard clients diffing the object.
    expect(Object.keys(body['update'] as object)).toEqual(['channel', 'current', 'available', 'state', 'deferredReason']);
  });

  it('falls back to disabled when no updater is attached', async () => {
    const body = await health();
    expect(body['update']).toEqual(updateBody('9.9.9'));
    expect(body['update']).toMatchObject({ state: 'disabled', available: null, current: '9.9.9' });
  });

  it('reads the provider live — a later transition shows up without a restart', async () => {
    let live = status();
    const server = createServer({
      config: testConfig(),
      limits: new EmptyLimitsProvider(),
      version: '9.9.9',
      update: () => live,
    });
    started.push(server);
    const port = await server.listen(0, '127.0.0.1');
    const read = async (): Promise<unknown> => ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, unknown>)['update'];

    await expect(read()).resolves.toMatchObject({ state: 'idle' });
    live = status({ state: 'downloading', available: '9.9.10+abc' });
    await expect(read()).resolves.toMatchObject({ state: 'downloading', available: '9.9.10+abc' });
  });
});
