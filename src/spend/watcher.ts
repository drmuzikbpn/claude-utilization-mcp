/**
 * Transcript watcher (spec §5.3, §23.7).
 *
 * `fs.watch(projectsDir, { recursive: true })` with a 500 ms debounce, plus a 5-minute
 * safety sweep because recursive watching is unreliable on some Linux setups. The watcher
 * is started *before* the initial scan and stays paused until `resume()`, so appends that
 * land mid-scan are queued and drained afterwards instead of waiting for the sweep.
 */

import { watch, type FSWatcher } from 'node:fs';

export const DEFAULT_DEBOUNCE_MS = 500;
export const DEFAULT_SWEEP_MS = 5 * 60_000;

export interface WatcherOptions {
  dir: string;
  /** Re-scan callback. Never called concurrently with itself. */
  onFlush: () => void | Promise<void>;
  debounceMs?: number;
  sweepMs?: number;
  /** Reported, never thrown: watching is best-effort and the sweep is the backstop. */
  onError?: (error: unknown) => void;
}

export class TranscriptWatcher {
  readonly #dir: string;
  readonly #onFlush: () => void | Promise<void>;
  readonly #debounceMs: number;
  readonly #sweepMs: number;
  readonly #onError: (error: unknown) => void;

  #watcher: FSWatcher | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #sweep: NodeJS.Timeout | null = null;
  #paused = true;
  #pending = 0;
  #stopped = false;
  #flushing = false;
  #again = false;

  constructor(options: WatcherOptions) {
    this.#dir = options.dir;
    this.#onFlush = options.onFlush;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
    this.#onError = options.onError ?? (() => {});
  }

  /** Events seen since the last flush (non-zero only while paused, in practice). */
  get pending(): number {
    return this.#pending;
  }

  get watching(): boolean {
    return this.#watcher !== null;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Begin watching. Never rejects: an unwatchable directory (missing, EPERM, platform
   * without recursive support) degrades to the safety sweep.
   */
  async start(): Promise<void> {
    if (this.#stopped) return;
    try {
      this.#watcher = watch(this.#dir, { recursive: true, persistent: false }, () => {
        this.notify();
      });
      this.#watcher.on('error', (err) => {
        this.#onError(err);
        this.#watcher?.close();
        this.#watcher = null;
      });
    } catch (err) {
      this.#onError(err);
      this.#watcher = null;
    }

    // The sweep does not touch `#pending`: while paused it is a no-op, because the
    // post-scan drain already covers everything written up to that point.
    this.#sweep = setInterval(() => {
      this.#fire();
    }, this.#sweepMs);
    this.#sweep.unref?.();
  }

  /** Record a change. While paused the event only accumulates. */
  notify(_path?: string): void {
    if (this.#stopped) return;
    this.#pending += 1;
    if (this.#paused) return;

    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.#fire();
    }, this.#debounceMs);
    this.#debounce.unref?.();
  }

  /** Drain anything queued during the initial scan and start delivering live events. */
  resume(): void {
    if (this.#stopped) return;
    this.#paused = false;
    if (this.#pending > 0) this.#fire();
  }

  stop(): void {
    this.#stopped = true;
    this.#paused = true;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  /**
   * `onFlush` is invoked synchronously so a synchronous callback is finished before this
   * returns; only a thenable result defers completion. Anything raised mid-flush queues a
   * single follow-up run rather than overlapping.
   */
  #fire(): void {
    if (this.#stopped || this.#paused) return;
    if (this.#flushing) {
      this.#again = true;
      return;
    }
    this.#pending = 0;
    this.#flushing = true;

    let result: void | Promise<void>;
    try {
      result = this.#onFlush();
    } catch (err) {
      this.#onError(err);
      this.#finish();
      return;
    }

    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).then(
        () => this.#finish(),
        (err: unknown) => {
          this.#onError(err);
          this.#finish();
        },
      );
      return;
    }
    this.#finish();
  }

  #finish(): void {
    this.#flushing = false;
    if (!this.#again) return;
    this.#again = false;
    this.#pending = 0;
    this.#fire();
  }
}
