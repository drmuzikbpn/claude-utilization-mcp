import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchAgentsDir, macLogDir } from '../paths.js';
import {
  defaultExec,
  ServiceError,
  LAUNCHD_LABEL,
  LOG_TRUNCATE_BYTES,
  tailLines,
  type ExecRunner,
  type ServiceManager,
  type ServiceManagerOptions,
  type ServiceState,
  type ServiceUnit,
} from './index.js';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

export interface PlistPaths {
  stdout: string;
  stderr: string;
}

/** Render the LaunchAgent plist (§23.9). Deterministic — tests compare it verbatim. */
export function renderPlist(unit: ServiceUnit, logs: PlistPaths, label = LAUNCHD_LABEL): string {
  const args = [unit.nodePath, unit.binPath, ...unit.args];
  const envKeys = Object.keys(unit.env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.map((a) => `\t\t<string>${xml(a)}</string>`).join('\n')}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envKeys.map((k) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(unit.env[k] ?? '')}</string>`).join('\n')}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${xml(logs.stdout)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logs.stderr)}</string>
</dict>
</plist>
`;
}

/** macOS `launchctl` (per-user GUI domain) implementation of `ServiceManager`. */
export class LaunchdService implements ServiceManager {
  readonly kind = 'launchd' as const;
  readonly label: string;
  readonly unitPath: string;
  readonly logDir: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
  private readonly exec: ExecRunner;
  private readonly uid: number;

  constructor(opts: ServiceManagerOptions & { label?: string } = {}) {
    const env = opts.env ?? process.env;
    this.label = opts.label ?? LAUNCHD_LABEL;
    this.unitPath = join(launchAgentsDir(env), `${this.label}.plist`);
    this.logDir = macLogDir(env);
    this.stdoutLog = join(this.logDir, 'daemon.out.log');
    this.stderrLog = join(this.logDir, 'daemon.err.log');
    this.exec = opts.exec ?? defaultExec;
    this.uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  }

  /** `gui/<uid>` — the domain target. */
  get domain(): string {
    return `gui/${String(this.uid)}`;
  }

  /** `gui/<uid>/<label>` — the service target. */
  get target(): string {
    return `${this.domain}/${this.label}`;
  }

  private async run(args: readonly string[], tolerate = false): Promise<void> {
    const result = await this.exec('launchctl', args);
    if (result.code !== 0 && !tolerate) {
      throw new ServiceError(`launchctl ${args.join(' ')} failed (exit ${String(result.code)})`, result);
    }
  }

  /** Create the log dir 0700 and truncate anything already over 10 MB (§23.9). */
  private prepareLogs(): void {
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.logDir, 0o700);
    } catch {
      // best effort — a pre-existing directory we do not own
    }
    for (const file of [this.stdoutLog, this.stderrLog]) {
      try {
        if (statSync(file).size > LOG_TRUNCATE_BYTES) truncateSync(file, 0);
      } catch {
        // no log yet, or not ours — launchd creates it on first run
      }
    }
  }

  async install(unit: ServiceUnit): Promise<void> {
    this.prepareLogs();
    mkdirSync(join(this.unitPath, '..'), { recursive: true });
    writeFileSync(this.unitPath, renderPlist(unit, { stdout: this.stdoutLog, stderr: this.stderrLog }, this.label), {
      mode: 0o644,
    });
    // bootout first so a re-run picks up the rewritten plist; not being loaded is fine.
    await this.run(['bootout', this.target], true);
    await this.run(['bootstrap', this.domain, this.unitPath]);
  }

  async uninstall(): Promise<void> {
    await this.run(['bootout', this.target], true);
    rmSync(this.unitPath, { force: true });
  }

  async start(): Promise<void> {
    if (existsSync(this.unitPath)) await this.run(['bootstrap', this.domain, this.unitPath], true);
    await this.run(['kickstart', this.target]);
  }

  async stop(): Promise<void> {
    await this.run(['bootout', this.target], true);
  }

  async restart(): Promise<void> {
    await this.run(['kickstart', '-k', this.target]);
  }

  async status(): Promise<ServiceState> {
    if (!existsSync(this.unitPath)) return 'not-installed';
    const result = await this.exec('launchctl', ['print', this.target]);
    if (result.code !== 0) return 'stopped';
    return /^\s*pid\s*=\s*\d+/m.test(result.stdout) ? 'running' : 'stopped';
  }

  async logTail(n: number): Promise<string[]> {
    try {
      return tailLines(readFileSync(this.stderrLog, 'utf8'), n);
    } catch {
      return [];
    }
  }
}
