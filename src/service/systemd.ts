import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { systemdUserDir } from '../paths.js';
import {
  defaultExec,
  ServiceError,
  SYSTEMD_UNIT,
  SYSTEMD_UNIT_NAME,
  tailLines,
  type ExecRunner,
  type ServiceManager,
  type ServiceManagerOptions,
  type ServiceState,
  type ServiceUnit,
} from './index.js';

/** Result of `loginctl enable-linger` — reported, never fatal (§23.9). */
export interface LingerReport {
  ok: boolean;
  message: string;
}

/** Render the systemd user unit (§23.9). Deterministic — tests compare it verbatim. */
export function renderUnit(unit: ServiceUnit): string {
  const envLines = Object.keys(unit.env)
    .map((k) => `Environment=${k}=${unit.env[k] ?? ''}`)
    .join('\n');
  const exec = [unit.nodePath, unit.binPath, ...unit.args].join(' ');
  return `[Unit]
Description=claude-usage — local usage service for Claude Code sessions
After=network.target

[Service]
Type=simple
ExecStart=${exec}
${envLines}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Linux `systemctl --user` implementation of `ServiceManager`. */
export class SystemdService implements ServiceManager {
  readonly kind = 'systemd' as const;
  readonly unitPath: string;
  readonly unitName = SYSTEMD_UNIT;
  private readonly exec: ExecRunner;
  private readonly user: string;

  constructor(opts: ServiceManagerOptions & { user?: string } = {}) {
    const env = opts.env ?? process.env;
    this.unitPath = join(systemdUserDir(env), SYSTEMD_UNIT);
    this.exec = opts.exec ?? defaultExec;
    this.user = opts.user ?? env['USER'] ?? safeUsername();
  }

  private async systemctl(args: readonly string[], tolerate = false): Promise<string> {
    const result = await this.exec('systemctl', ['--user', ...args]);
    if (result.code !== 0 && !tolerate) {
      throw new ServiceError(`systemctl --user ${args.join(' ')} failed (exit ${String(result.code)})`, result);
    }
    return result.stdout;
  }

  async install(unit: ServiceUnit): Promise<void> {
    mkdirSync(join(this.unitPath, '..'), { recursive: true });
    writeFileSync(this.unitPath, renderUnit(unit), { mode: 0o644 });
    await this.systemctl(['daemon-reload']);
    await this.systemctl(['enable', '--now', SYSTEMD_UNIT]);
  }

  async uninstall(): Promise<void> {
    await this.systemctl(['disable', '--now', SYSTEMD_UNIT], true);
    rmSync(this.unitPath, { force: true });
    await this.systemctl(['daemon-reload'], true);
  }

  async start(): Promise<void> {
    await this.systemctl(['start', SYSTEMD_UNIT]);
  }

  async stop(): Promise<void> {
    await this.systemctl(['stop', SYSTEMD_UNIT], true);
  }

  async restart(): Promise<void> {
    await this.systemctl(['daemon-reload']);
    await this.systemctl(['restart', SYSTEMD_UNIT]);
  }

  async status(): Promise<ServiceState> {
    if (!existsSync(this.unitPath)) return 'not-installed';
    const result = await this.exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
    return result.stdout.trim() === 'active' ? 'running' : 'stopped';
  }

  /** Journal, not files — systemd has no log paths (§23.9). */
  async logTail(n: number): Promise<string[]> {
    const result = await this.exec('journalctl', [
      '--user',
      '-u',
      SYSTEMD_UNIT_NAME,
      '-n',
      String(n),
      '--no-pager',
    ]);
    if (result.code !== 0) return [];
    return tailLines(result.stdout, n);
  }

  /**
   * `install --linger`: keep the unit alive outside a login session. Reports, never
   * fails — and uninstall never touches it.
   */
  async enableLinger(): Promise<LingerReport> {
    const result = await this.exec('loginctl', ['enable-linger', this.user]);
    if (result.code === 0) return { ok: true, message: `lingering enabled for ${this.user}` };
    if (result.code === 127) {
      return { ok: false, message: 'loginctl not found — lingering not enabled (the daemon stops at logout)' };
    }
    const detail = result.stderr.trim() || `exit ${String(result.code)}`;
    return { ok: false, message: `loginctl enable-linger ${this.user} failed: ${detail}` };
  }
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}
