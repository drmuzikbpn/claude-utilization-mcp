// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { DaemonClient, isPidAlive, readDaemonInfo } from '../clients/http.js';
import { ConfigError, validateConfig, type Config } from '../config.js';
import { buildUnit } from '../service/index.js';
import { addMcpServer, removeMcpServer } from './claude-json.js';
import {
  generateToken,
  loadConfigWithToken,
  persistConfig,
  resolveContext,
  type InstallIO,
  type ResolvedContext,
} from './context.js';
import { InstallError } from './plan.js';
import { applySettings, removeSettings } from './settings-merge.js';

/** `claude-usage configure` (§8, §16 pairing). */

export type Toggle = 'service' | 'hook' | 'mcp' | 'statusline' | 'autoupdate' | 'lan';
const TOGGLES: readonly Toggle[] = ['service', 'hook', 'mcp', 'statusline', 'autoupdate', 'lan'];

function isToggle(v: string): v is Toggle {
  return (TOGGLES as readonly string[]).includes(v);
}

/**
 * What `configure pairing` says now (§23.57). It used to print a QR code carrying the
 * bearer token itself, to be scanned over plain HTTP; both halves of that are gone.
 */
export const PAIRING_REMOVED =
  'claude-usage: `configure pairing` has been removed — it put the bearer token in a QR code.\n' +
  '  Run `claude-usage pair` instead: a one-time, five-minute code over pinned HTTPS.\n';

function flagNumber(argv: readonly string[], name: string): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let raw: string | undefined;
    if (arg === name) raw = argv[i + 1];
    else if (arg.startsWith(`${name}=`)) raw = arg.slice(name.length + 1);
    if (raw === undefined) continue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) throw new InstallError(`claude-usage configure: ${name} needs a number`);
    return n;
  }
  return null;
}

export type AdoptOutcome = { state: 'no-daemon' } | { state: 'adopted'; pid: number } | { state: 'failed'; pid: number; why: string };

/** How long a signalled daemon is given to start answering to the new token. */
export const ADOPT_TIMEOUT_MS = 3_000;

/**
 * §23.58: make a running, unsupervised daemon take the token that was just written.
 * `SIGHUP` asks it to re-read `auth.token`; the proof that it did is that it now answers a
 * request carrying the new token — which is exactly what `DaemonClient` sends.
 */
export async function adoptRotatedToken(
  configDir: string,
  deps: { kill?: (pid: number, signal: NodeJS.Signals) => void; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AdoptOutcome> {
  const info = readDaemonInfo(configDir);
  if (info === null || !isPidAlive(info.pid)) return { state: 'no-daemon' };
  try {
    (deps.kill ?? ((pid, signal) => process.kill(pid, signal)))(info.pid, 'SIGHUP');
  } catch (err) {
    return { state: 'failed', pid: info.pid, why: `it could not be signalled (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (deps.timeoutMs ?? ADOPT_TIMEOUT_MS);
  const client = new DaemonClient({ configDir, timeoutMs: 1_000 });
  for (;;) {
    try {
      await client.get('/v1/config');
      return { state: 'adopted', pid: info.pid };
    } catch {
      if (Date.now() >= deadline) return { state: 'failed', pid: info.pid, why: 'it did not answer to the new token' };
      await sleep(100);
    }
  }
}

/** Turn one integration on or off, doing exactly what install did / undoing it. */
export async function setToggle(ctx: ResolvedContext, io: InstallIO, toggle: Toggle, on: boolean, config: Config): Promise<string> {
  switch (toggle) {
    case 'service': {
      if (on) {
        await ctx.service.install(buildUnit({ nodePath: ctx.nodePath, binPath: ctx.binPath, env: ctx.env }));
      } else {
        await ctx.service.stop();
        await ctx.service.uninstall();
      }
      config.integrations = { ...config.integrations, service: on };
      return `service ${on ? 'installed and started' : 'stopped and removed'}`;
    }
    case 'hook':
    case 'statusline': {
      const isHook = toggle === 'hook';
      if (on) {
        const r = applySettings({
          file: ctx.settingsFile,
          binPath: ctx.binPath,
          hook: isHook,
          statusline: !isHook,
        });
        if (!isHook && r.statusLine?.outcome === 'other-exists') {
          io.stdout(
            `you already have a statusLine — add this line to your own status line script, after it reads stdin into $input:\n  ${r.statusLine.snippet}\n`,
          );
        }
      } else {
        removeSettings({ file: ctx.settingsFile, binPath: ctx.binPath, hook: isHook, statusline: !isHook });
      }
      config.integrations = { ...config.integrations, [toggle]: on };
      return `${toggle} ${on ? 'on' : 'off'}`;
    }
    case 'mcp': {
      const opts = {
        file: ctx.claudeJsonFile,
        binPath: ctx.binPath,
        ...(ctx.exec === undefined ? {} : { exec: ctx.exec }),
      };
      if (on) await addMcpServer(opts);
      else await removeMcpServer(opts);
      config.integrations = { ...config.integrations, mcp: on };
      return `mcp ${on ? 'on' : 'off'}`;
    }
    case 'autoupdate': {
      config.autoUpdate = { ...config.autoUpdate, enabled: on };
      return `autoupdate ${on ? 'on' : 'off'}`;
    }
    case 'lan': {
      // §23.44: `bind` is read at startup, so the caller restarts the service after saving.
      const rest = config.bind.filter((entry) => entry.trim().toLowerCase() !== 'lan');
      config.bind = on ? [...rest, 'lan'] : rest.length > 0 ? rest : ['127.0.0.1'];
      return `lan ${on ? 'on' : 'off'}`;
    }
  }
}


async function interactiveMenu(ctx: ResolvedContext, io: InstallIO, config: Config): Promise<string[]> {
  const prompt = io.prompt;
  const ask = io.ask;
  if (prompt === undefined || ask === undefined) {
    if (io.isTTY !== true && process.stdout.isTTY !== true) {
      throw new InstallError(
        'claude-usage configure needs a terminal — use the scriptable form, e.g. `claude-usage configure hook off`',
      );
    }
  }
  const yesNo = prompt ?? (await import('./plan.js')).readlinePrompter();
  const text =
    ask ??
    (async (question: string, def: string): Promise<string> => {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`${question} [${def}] `);
        return answer.trim().length === 0 ? def : answer.trim();
      } finally {
        rl.close();
      }
    });

  const changes: string[] = [];
  for (const toggle of TOGGLES) {
    const current =
      toggle === 'autoupdate'
        ? config.autoUpdate.enabled
        : toggle === 'lan'
          ? config.bind.some((entry) => entry.trim().toLowerCase() === 'lan')
          : config.integrations[toggle];
    const wanted = await yesNo(`${toggle}?`, current);
    if (wanted !== current) changes.push(await setToggle(ctx, io, toggle, wanted, config));
  }

  const numbers: Array<[string, number, (v: number) => void]> = [
    ['warn threshold %', config.thresholds.warn, (v) => (config.thresholds = { ...config.thresholds, warn: v })],
    ['critical threshold %', config.thresholds.critical, (v) => (config.thresholds = { ...config.thresholds, critical: v })],
    ['port', config.port, (v) => (config.port = v)],
    ['poll interval (ms)', config.pollIntervalMs, (v) => (config.pollIntervalMs = v)],
    ['hook debounce (minutes)', config.hookDebounceMinutes, (v) => (config.hookDebounceMinutes = v)],
  ];
  for (const [label, current, set] of numbers) {
    const answer = await text(label, String(current));
    const parsed = Number.parseInt(answer, 10);
    if (Number.isFinite(parsed) && parsed !== current) {
      set(parsed);
      changes.push(`${label} → ${String(parsed)}`);
    }
  }
  return changes;
}

export async function runConfigure(argv: readonly string[], io: InstallIO): Promise<number> {
  const ctx = await resolveContext(io);
  const sub = argv[0];
  const rest = argv.slice(1);

  try {
    if (sub === 'pairing') {
      io.stderr(PAIRING_REMOVED);
      return 1;
    }

    const { config } = loadConfigWithToken(ctx.configDir, io.randomToken);
    const changes: string[] = [];
    /** Restart the service once the new config is on disk — never before (§23.44). */
    let restart = false;
    let rotated = false;
    const bindBefore = JSON.stringify(config.bind);

    if (sub === undefined) {
      changes.push(...(await interactiveMenu(ctx, io, config)));
    } else if (isToggle(sub)) {
      const state = rest[0];
      if (state !== 'on' && state !== 'off') {
        io.stderr(`claude-usage configure ${sub}: expected "on" or "off"\n`);
        return 1;
      }
      changes.push(await setToggle(ctx, io, sub, state === 'on', config));
    } else if (sub === 'thresholds') {
      const warn = flagNumber(rest, '--warn');
      const critical = flagNumber(rest, '--critical');
      if (warn === null && critical === null) {
        io.stderr('claude-usage configure thresholds: pass --warn N and/or --critical N\n');
        return 1;
      }
      config.thresholds = {
        ...config.thresholds,
        ...(warn === null ? {} : { warn }),
        ...(critical === null ? {} : { critical }),
      };
      if (config.thresholds.warn > config.thresholds.critical) {
        io.stderr('claude-usage configure thresholds: --warn must not exceed --critical\n');
        return 1;
      }
      changes.push(`thresholds warn ${String(config.thresholds.warn)} / critical ${String(config.thresholds.critical)}`);
    } else if (sub === 'port') {
      const raw = rest[0];
      const port = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        io.stderr('claude-usage configure port: expected a port number between 0 and 65535\n');
        return 1;
      }
      config.port = port;
      changes.push(`port ${String(port)}`);
      if (config.integrations.service) {
        // The unit embeds nothing port-specific today, but rewriting it keeps the
        // unit and config in step, and the restart picks the new port up (§8).
        await ctx.service.install(buildUnit({ nodePath: ctx.nodePath, binPath: ctx.binPath, env: ctx.env }));
        restart = true;
        changes.push('service unit rewritten and restarted');
      }
    } else if (sub === 'rotate-token') {
      config.auth = { ...config.auth, token: (io.randomToken ?? generateToken)() };
      changes.push('bearer token rotated — re-pair every device: claude-usage pair');
      // The daemon holds the token in memory; until it re-reads it the old one keeps working.
      restart = true;
      rotated = true;
    } else {
      io.stderr(`claude-usage configure: unknown setting "${sub}"\n`);
      io.stderr('  configure [service|hook|mcp|statusline|autoupdate|lan] <on|off>\n');
      io.stderr('  configure thresholds --warn N --critical N\n');
      io.stderr('  configure port N | rotate-token\n');
      return 1;
    }

    // Never save a config the daemon would refuse to start with (e.g. tls.port collisions).
    try {
      validateConfig(config);
    } catch (err) {
      if (err instanceof ConfigError) {
        io.stderr(`claude-usage configure: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    // `bind` is only read at startup (§23.44), so a changed one needs a restart too.
    if (JSON.stringify(config.bind) !== bindBefore) restart = true;
    persistConfig(config, ctx.configDir);
    if (restart && config.integrations.service) await ctx.service.restart();
    if (changes.length === 0) io.stdout('no changes\n');
    for (const change of changes) io.stdout(`${change}\n`);
    // §23.58: a daemon nobody supervises — `claude-usage serve` in a terminal — was not
    // restarted above. Tell it to re-read the token, and say so plainly if that fails.
    if (rotated && !config.integrations.service) {
      const outcome = await (io.adoptToken ?? adoptRotatedToken)(ctx.configDir);
      if (outcome.state === 'adopted') {
        io.stdout(`the running daemon (pid ${String(outcome.pid)}) has taken the new token\n`);
      } else if (outcome.state === 'failed') {
        io.stderr(
          `claude-usage: the running daemon (pid ${String(outcome.pid)}) is STILL ACCEPTING THE OLD TOKEN — ${outcome.why}.\n` +
            '  Stop it and start it again; until then the old token works.\n',
        );
        return 1;
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof InstallError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
