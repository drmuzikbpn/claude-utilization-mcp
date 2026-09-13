import type { Timers } from '../../src/limits/poller.js';

interface Entry {
  id: number;
  at: number;
  cb: () => void;
}

/** Deterministic injectable clock — no global timer patching, so promises still settle. */
export class FakeTimers implements Timers {
  clock = 0;
  private nextId = 1;
  private entries: Entry[] = [];

  setTimeout = (cb: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.entries.push({ id, at: this.clock + ms, cb });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.entries = this.entries.filter((e) => e.id !== handle);
  };

  get pendingCount(): number {
    return this.entries.length;
  }

  /** Delay of the single pending timer, or null when nothing is scheduled. */
  get nextDelay(): number | null {
    const next = this.entries[0];
    return next === undefined ? null : next.at - this.clock;
  }

  /** Advance the clock, firing due callbacks and flushing microtasks after each. */
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      const due = this.entries.filter((e) => e.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.clock = due.at;
      this.entries = this.entries.filter((e) => e.id !== due.id);
      due.cb();
      await flush();
    }
    this.clock = target;
    await flush();
  }
}

/** Let every already-queued promise continuation run. */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      setImmediate(() => resolve());
    });
  });
}
