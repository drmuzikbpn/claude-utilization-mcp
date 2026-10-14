// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * §23.56: the last thing a dying daemon does.
 *
 * An exception nobody caught must not leave a single process stopped. SIGCONT what memory
 * knows about, then what `sessions.json` knows about (the two differ only if the crash was
 * mid-write), then exit non-zero so the supervisor restarts us and the standing pause rules
 * are applied afresh. Everything is synchronous and nothing here can throw.
 *
 * Lives outside `daemon.ts` on purpose: that file must never contain a bare exit (§23.18).
 */
import { rmSync } from 'node:fs';
import { daemonFilePath } from './clients/http.js';
import { thawRecorded, type FreezeDeps } from './pause/freeze.js';

export interface CrashContext {
  configDir: string;
  /** Thaws what the running daemon holds in memory; absent before startup has got that far. */
  thawLive: () => void;
  log: (line: string) => void;
  exit: (code: number) => void;
  /** Test seam for the on-disk thaw. */
  freezeDeps?: FreezeDeps;
}

export function crashHandler(ctx: CrashContext): (err: unknown) => void {
  let crashing = false;
  return (err: unknown) => {
    if (crashing) return;
    crashing = true;
    try {
      ctx.log(`claude-usage: fatal — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    } catch {
      // logging must not stop the thaw
    }
    try {
      ctx.thawLive();
    } catch {
      // fall through to the on-disk record
    }
    try {
      const resumed = ctx.freezeDeps === undefined ? thawRecorded(ctx.configDir) : thawRecorded(ctx.configDir, ctx.freezeDeps);
      if (resumed.length > 0) ctx.log(`claude-usage: resumed ${String(resumed.length)} frozen process(es) before exiting`);
    } catch {
      // nothing more can be done
    }
    try {
      rmSync(daemonFilePath(ctx.configDir), { force: true });
    } catch {
      // best effort
    }
    ctx.exit(1);
  };
}

/** Wire `crashHandler` to the process; returns the function that unwires it. */
export function installCrashHandlers(ctx: Omit<CrashContext, 'exit'>): () => void {
  const onCrash = crashHandler({ ...ctx, exit: (code) => process.exit(code) });
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  return () => {
    process.removeListener('uncaughtException', onCrash);
    process.removeListener('unhandledRejection', onCrash);
  };
}
