import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, ExecRunner } from '../../src/service/index.js';

/**
 * Shared W6 test scaffolding: a throwaway HOME with its own XDG dirs, and an exec
 * runner that records every command instead of touching launchctl/systemctl/claude.
 */

export interface TempHome {
  home: string;
  env: NodeJS.ProcessEnv;
  configDir: string;
  dataHome: string;
  cleanup(): void;
}

const roots: string[] = [];

export function tempHome(extra: NodeJS.ProcessEnv = {}): TempHome {
  const home = mkdtempSync(join(tmpdir(), 'cu-home-'));
  roots.push(home);
  const configHome = join(home, '.config');
  const dataHome = join(home, '.local', 'share');
  mkdirSync(configHome, { recursive: true });
  mkdirSync(dataHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    PATH: '/usr/bin:/bin',
    USER: 'testuser',
    ...extra,
  };
  return {
    home,
    env,
    configDir: join(configHome, 'claude-usage'),
    dataHome,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Remove every temp home this process created. Call from `afterAll`. */
export function cleanupAllTempHomes(): void {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r !== undefined) rmSync(r, { recursive: true, force: true });
  }
}

export interface RecordedCommand {
  file: string;
  args: string[];
}

export interface FakeExec {
  runner: ExecRunner;
  calls: RecordedCommand[];
  /** Rendered as `file arg arg …` — what assertions compare against. */
  lines(): string[];
}

export type ExecResponder = (file: string, args: readonly string[]) => Partial<ExecResult> | undefined;

/** An exec runner that records calls and answers `{ code: 0 }` unless `respond` says otherwise. */
export function fakeExec(respond: ExecResponder = () => undefined): FakeExec {
  const calls: RecordedCommand[] = [];
  const runner: ExecRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    const over = respond(file, args) ?? {};
    return { code: 0, stdout: '', stderr: '', ...over };
  };
  return {
    runner,
    calls,
    lines: () => calls.map((c) => [c.file, ...c.args].join(' ')),
  };
}
