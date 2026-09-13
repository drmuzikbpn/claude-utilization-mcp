import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ExecResult,
  ExecRunner,
  ServiceManager,
  ServiceState,
  ServiceUnit,
} from '../../src/service/index.js';
import type { Prompter } from '../../src/install/plan.js';

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

/** A `ServiceManager` that records what install/uninstall would have done. */
export class FakeService implements ServiceManager {
  readonly kind: 'launchd' | 'systemd' | 'noop';
  readonly unitPath: string;
  readonly calls: string[] = [];
  unit: ServiceUnit | null = null;
  state: ServiceState = 'not-installed';
  logs: string[] = [];

  constructor(kind: 'launchd' | 'systemd' | 'noop' = 'launchd', unitPath = '/fake/LaunchAgents/claude-usage.plist') {
    this.kind = kind;
    this.unitPath = kind === 'noop' ? '' : unitPath;
  }

  async install(unit: ServiceUnit): Promise<void> {
    this.calls.push('install');
    this.unit = unit;
    this.state = 'running';
  }

  async uninstall(): Promise<void> {
    this.calls.push('uninstall');
    this.state = 'not-installed';
  }

  async start(): Promise<void> {
    this.calls.push('start');
    this.state = 'running';
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this.state = 'stopped';
  }

  async restart(): Promise<void> {
    this.calls.push('restart');
    this.state = 'running';
  }

  async status(): Promise<ServiceState> {
    return this.state;
  }

  async logTail(n: number): Promise<string[]> {
    return this.logs.slice(-n);
  }
}

/** A prompter that replays scripted answers and records the questions it was asked. */
export function scriptedPrompter(answers: readonly boolean[]): { prompt: Prompter; questions: string[] } {
  const questions: string[] = [];
  let i = 0;
  const prompt: Prompter = async (question, defaultYes) => {
    questions.push(question);
    const answer = answers[i];
    i += 1;
    return answer ?? defaultYes;
  };
  return { prompt, questions };
}

/** A minimal package directory that `installVersion` can copy. */
export function fakePackage(version = '9.9.9'): string {
  const dir = mkdtempSync(join(tmpdir(), 'cu-pkg-'));
  roots.push(dir);
  const write = (rel: string, body: string): void => {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  write(
    'package.json',
    `${JSON.stringify({ name: '@drmuzikbpn/claude-usage', version, bin: { 'claude-usage': 'bin/claude-usage' } }, null, 2)}\n`,
  );
  write('bin/claude-usage', '#!/usr/bin/env node\n');
  write('dist/cli.js', 'export const main = () => 0;\n');
  write('README.md', 'fake package\n');
  // must NOT be copied into the versions layout
  write('node_modules/left-pad/index.js', 'module.exports = 1;\n');
  write('.git/HEAD', 'ref: refs/heads/main\n');
  return dir;
}
