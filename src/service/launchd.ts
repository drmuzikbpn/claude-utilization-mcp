import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchAgentsDir, macLogDir } from '../paths.js';
import {
  defaultExec,
  ServiceError,
  LAUNCHD_LABEL,
  LOG_TRUNCATE_BYTES,
  tailLines,
  UPDATE_RESTART_EXIT_CODE,
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
\t<!-- Exit 0 means "stay down" (configure service off); the auto-updater asks for a
\t     relaunch by exiting ${String(UPDATE_RESTART_EXIT_CODE)}, mirroring systemd's Restart=on-failure. -->
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

/** errno 37, `EALREADY` — launchctl's answer while a previous operation is still settling. */
const EALREADY = 37;
/** How many times to re-attempt a bootstrap that raced its own bootout (§23.26). */
const BOOTSTRAP_ATTEMPTS = 5;
/** Pause between those attempts. */
const BOOTSTRAP_RETRY_WAIT_MS = 400;

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
  /** Pause between bootstrap retries; 0 in tests. */
  private readonly retryWaitMs: number;

  constructor(opts: ServiceManagerOptions & { label?: string } = {}) {
    const env = opts.env ?? process.env;
    this.label = opts.label ?? LAUNCHD_LABEL;
    this.unitPath = join(launchAgentsDir(env), `${this.label}.plist`);
    this.logDir = macLogDir(env);
    this.stdoutLog = join(this.logDir, 'daemon.out.log');
    this.stderrLog = join(this.logDir, 'daemon.err.log');
    this.exec = opts.exec ?? defaultExec;
    this.uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
    this.retryWaitMs = opts.retryWaitMs ?? BOOTSTRAP_RETRY_WAIT_MS;
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
    await this.bootstrapWithRetry();
    // RunAtLoad does not reliably start the job when bootstrapping from a non-GUI session
    // (e.g. over SSH), so ask for it explicitly; this is also what makes install idempotent.
    // In a GUI session RunAtLoad *does* fire, so this can arrive while launchd is already
    // starting the job and come back EALREADY — that is the job starting, not failing.
    const kick = await this.exec('launchctl', ['kickstart', '-k', this.target]);
    if (kick.code !== 0 && kick.code !== EALREADY) {
      throw new ServiceError(`launchctl kickstart -k ${this.target} failed (exit ${String(kick.code)})`, kick);
    }
  }

  /**
   * Bootstrap the job, waiting out the tail of our own `bootout` (§23.26).
   *
   * `launchctl bootout` returns before launchd has finished tearing the job down, and
   * anything that lands in that window fails with `EALREADY` (errno 37). On the Mac Studio
   * this bit during the desktop install meant to repair it: the bootstrap failed into the
   * tolerate branch, `kickstart` then failed too, and the install aborted having booted the
   * service out and never put it back — daemon down, LaunchAgent unregistered.
   *
   * A race is worth waiting out rather than tolerating. Other failures stay tolerated for the
   * original reason: aborting after the bootout is what leaves the daemon down.
   */
  private async bootstrapWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt += 1) {
      const result = await this.exec('launchctl', ['bootstrap', this.domain, this.unitPath]);
      if (result.code === 0 || result.code !== EALREADY) return;
      if (attempt < BOOTSTRAP_ATTEMPTS - 1 && this.retryWaitMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.retryWaitMs).unref?.();
        });
      }
    }
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

  /**
   * `Aqua` when this process belongs to the GUI login session, `Background` or `StandardIO`
   * over ssh. `null` when launchctl cannot say, which is treated as "no finding".
   */
  private async managerName(): Promise<string | null> {
    try {
      const result = await this.exec('launchctl', ['managername']);
      return result.code === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Problems that leave a *loaded, running* job unable to look after itself (§23.20, §23.25).
   *
   * The fault: bootstrapping from a non-GUI session — an `install` run over SSH — registers
   * the job in `gui/<uid>` but leaves its spawns pended. `RunAtLoad` never fires, and neither
   * does `KeepAlive`. Measured on the Mac Studio: `kill -9` on a job up well past
   * `minimum runtime = 10` left it down for the full 60s watch with `runs` frozen at 7, while
   * the same job on a locally-installed MacBook came back unattended in 5s (`runs` 15 → 16).
   *
   * ## Why the `pended nondemand spawn` line is not enough (§23.25)
   *
   * That line is only printed while the job is **not running**. `install()` ends with
   * `kickstart -k`, so by the time the installer calls this the job is always up and the line
   * is always gone — the check could never fire from the one code path that calls it. On the
   * Studio, in one ssh session: zero matches for the phrase while running, then
   * `pended nondemand spawn = semaphore` twenty seconds after a `kill -9`. A healthy machine
   * and a broken one are byte-identical in `launchctl print` while both are up; `runs`,
   * `properties = runatload` and `immediate reason` were all checked and none separate them
   * (`immediate reason` only reports how the *current* instance was started — it flips to
   * `non-ipc demand` on a healthy Mac after any `kickstart`).
   *
   * So the readable signal at install time is the session this process is running in. That is
   * also the honest one: it reports the cause, not a symptom that has already been papered
   * over by the kickstart two lines earlier.
   *
   * Note for anyone grepping by hand: match the whole phrase. `pended` is a substring of
   * `started suspended = 0`, which every healthy job prints twice — a loose `grep -c pended`
   * returns 2 on a perfectly good machine.
   *
   * Returns human-readable warnings, empty when nothing is wrong. Never throws: a
   * diagnostic that fails must not fail an install.
   */
  async diagnose(): Promise<string[]> {
    const remedy =
      'The daemon runs, and updates restart it, but launchd will NOT bring it back after a ' +
      'crash or a reboot. Re-run `claude-usage install` from a terminal on that machine\'s own ' +
      'desktop to get a self-healing service.';
    // Session type first, and deliberately before any `launchctl print` (§23.26): the
    // session is knowable whether or not the job is loaded, and `print` can fail transiently
    // in the settling window right after a bootstrap — which is exactly when the installer
    // asks. Gating the warning behind a successful print silently suppressed it on the Mac
    // Studio's first successful install, on the one machine it was written for.
    const manager = await this.managerName();
    if (manager !== null && manager !== 'Aqua') {
      return [
        `this install ran from a non-GUI session (launchctl managername = ${manager}, typically ` +
          `an ssh login), so launchd has pended the service's spawns. ${remedy} Note that ` +
          '`launchctl print` will look completely healthy while the daemon is up, so this ' +
          'warning is the only sign you will get.',
      ];
    }
    // GUI session: the job can still be pended from an earlier ssh install, and while it is
    // down launchd says so outright. A print that fails here is genuinely no finding.
    let out: string;
    try {
      const result = await this.exec('launchctl', ['print', this.target]);
      if (result.code !== 0) return [];
      out = result.stdout;
    } catch {
      return [];
    }
    if (/pended nondemand spawn/.test(out)) {
      return [`launchd registered the service but will not start it on its own. ${remedy}`];
    }
    return [];
  }

  async logTail(n: number): Promise<string[]> {
    try {
      return tailLines(readFileSync(this.stderrLog, 'utf8'), n);
    } catch {
      return [];
    }
  }
}
