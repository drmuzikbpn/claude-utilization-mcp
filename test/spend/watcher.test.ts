import { watch } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_SWEEP_MS,
  TranscriptWatcher,
} from '../../src/spend/watcher.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

afterEach(async () => {
  vi.useRealTimers();
  await cleanupTempDirs();
});

function recursiveWatchSupported(dir: string): boolean {
  try {
    watch(dir, { recursive: true }, () => {}).close();
    return true;
  } catch {
    return false;
  }
}

describe('TranscriptWatcher debounce', () => {
  it('coalesces a burst of change events into one flush', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();

    watcher.notify('a.jsonl');
    watcher.notify('b.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS - 1);
    watcher.notify('c.jsonl');
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // a later burst is a separate flush
    watcher.notify('d.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('honours a custom debounce window', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush, debounceMs: 20 });
    await watcher.start();
    watcher.resume();

    watcher.notify();
    vi.advanceTimersByTime(19);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

describe('TranscriptWatcher safety sweep', () => {
  it('flushes every 5 minutes even when no event arrived', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();

    vi.advanceTimersByTime(DEFAULT_SWEEP_MS - 1);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEFAULT_SWEEP_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('stops all timers on stop()', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();
    watcher.notify();
    watcher.stop();

    vi.advanceTimersByTime(DEFAULT_SWEEP_MS * 3);
    expect(onFlush).not.toHaveBeenCalled();
  });
});

describe('TranscriptWatcher mid-scan queueing', () => {
  it('queues events while paused and drains them on resume', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start(); // starts paused: the initial scan owns the store

    watcher.notify('a.jsonl');
    watcher.notify('b.jsonl');
    vi.advanceTimersByTime(DEFAULT_SWEEP_MS * 2);
    expect(onFlush).not.toHaveBeenCalled();
    expect(watcher.pending).toBe(2);

    watcher.resume();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(watcher.pending).toBe(0);
    watcher.stop();
  });

  it('does not flush on resume when nothing was queued', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();
    expect(onFlush).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('never runs two flushes concurrently and re-runs once for events raised mid-flush', async () => {
    const dir = await makeTempDir();
    let running = 0;
    let overlaps = 0;
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watcher = new TranscriptWatcher({
      dir,
      debounceMs: 1,
      onFlush: async () => {
        calls += 1;
        running += 1;
        if (running > 1) overlaps += 1;
        if (calls === 1) await gate;
        running -= 1;
      },
    });
    await watcher.start();
    watcher.resume();

    watcher.notify('a.jsonl');
    await new Promise((r) => setTimeout(r, 20));
    watcher.notify('b.jsonl'); // arrives while the first flush is still awaiting
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 50));

    expect(overlaps).toBe(0);
    expect(calls).toBe(2);
    watcher.stop();
  });
});

describe('TranscriptWatcher real filesystem events', () => {
  it('flushes when a transcript is written under a nested dir', async () => {
    const dir = await makeTempDir();
    if (!recursiveWatchSupported(dir)) return; // platform without recursive fs.watch

    let flushes = 0;
    const watcher = new TranscriptWatcher({
      dir,
      debounceMs: 20,
      sweepMs: 60_000,
      onFlush: () => {
        flushes += 1;
      },
    });
    await watcher.start();
    watcher.resume();

    await mkdir(join(dir, 'proj', 'session', 'subagents'), { recursive: true });
    await writeFile(join(dir, 'proj', 'session', 'subagents', 'agent-x.jsonl'), '{}\n');

    const deadline = Date.now() + 4000;
    while (flushes === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    watcher.stop();
    expect(flushes).toBeGreaterThan(0);
  });

  it('survives a missing directory without throwing', async () => {
    const dir = await makeTempDir();
    const watcher = new TranscriptWatcher({ dir: join(dir, 'absent'), onFlush: () => {} });
    await expect(watcher.start()).resolves.toBeUndefined();
    expect(watcher.watching).toBe(false);
    watcher.stop();
  });
});
