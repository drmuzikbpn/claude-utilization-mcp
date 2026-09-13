import { networkInterfaces } from 'node:os';
import { loadConfig, type Config } from '../config.js';
import { buildUnit, defaultExec, type ExecRunner } from '../service/index.js';
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

export type Toggle = 'service' | 'hook' | 'mcp' | 'statusline' | 'autoupdate';
const TOGGLES: readonly Toggle[] = ['service', 'hook', 'mcp', 'statusline', 'autoupdate'];

function isToggle(v: string): v is Toggle {
  return (TOGGLES as readonly string[]).includes(v);
}

/** `100.64.0.0/10` — the CGNAT range Tailscale hands out (§16). */
export function isTailscaleIPv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127;
}

/** First IPv4 in the tailnet range across all interfaces, or `null`. */
export function firstTailscaleIPv4(interfaces = networkInterfaces()): string | null {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && isTailscaleIPv4(a.address)) return a.address;
    }
  }
  return null;
}

export interface PairingAddr {
  addr: string;
  warning: string | null;
}

/** Interface scan → `tailscale ip -4` → loopback with a warning (§16). */
export async function resolvePairingAddr(opts: { exec?: ExecRunner; interfaces?: ReturnType<typeof networkInterfaces> } = {}): Promise<PairingAddr> {
  const direct = firstTailscaleIPv4(opts.interfaces ?? networkInterfaces());
  if (direct !== null) return { addr: direct, warning: null };

  const exec = opts.exec ?? defaultExec;
  const result = await exec('tailscale', ['ip', '-4']);
  const line = result.stdout.split('\n')[0]?.trim() ?? '';
  if (result.code === 0 && isTailscaleIPv4(line)) return { addr: line, warning: null };

  return {
    addr: '127.0.0.1',
    warning: 'no Tailscale address found — pairing will only work from this machine',
  };
}

export interface PairingPayload {
  v: 1;
  name: string;
  addr: string;
  port: number;
  token: string;
}

/** The QR renderer is CLI-only and imported lazily — the daemon never loads it. */
async function renderQr(text: string): Promise<string> {
  const mod = await import('qrcode-terminal');
  const generate = (mod as unknown as { default?: typeof mod; generate?: typeof mod.generate }).generate ?? mod.default?.generate;
  if (typeof generate !== 'function') return '';
  return new Promise<string>((resolve) => {
    generate(text, { small: true }, (qr: string) => {
      resolve(qr);
    });
  });
}

export async function runPairing(io: InstallIO, ctx: ResolvedContext, json: boolean): Promise<number> {
  const config = loadConfig(ctx.configDir);
  if (config.auth.token.length === 0) {
    io.stderr('claude-usage: no bearer token yet — run `claude-usage install` or `configure rotate-token`\n');
    return 1;
  }
  const { addr, warning } = await resolvePairingAddr(ctx.exec === undefined ? {} : { exec: ctx.exec });
  const payload: PairingPayload = { v: 1, name: config.name, addr, port: config.port, token: config.auth.token };
  const text = JSON.stringify(payload);
  io.stdout(`${text}\n`);
  if (!json) {
    const qr = await renderQr(text);
    if (qr.length > 0) io.stdout(`${qr}\n`);
  }
  if (warning !== null) io.stderr(`warning: ${warning}\n`);
  return 0;
}

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
          io.stdout(`you already have a statusLine — append this to your own script:\n  ${r.statusLine.snippet}\n`);
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
      toggle === 'autoupdate' ? config.autoUpdate.enabled : config.integrations[toggle as 'service' | 'hook' | 'mcp' | 'statusline'];
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
    if (sub === 'pairing') return await runPairing(io, ctx, rest.includes('--json'));

    const { config } = loadConfigWithToken(ctx.configDir, io.randomToken);
    const changes: string[] = [];

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
        await ctx.service.restart();
        changes.push('service unit rewritten and restarted');
      }
    } else if (sub === 'rotate-token') {
      config.auth = { ...config.auth, token: (io.randomToken ?? generateToken)() };
      changes.push('bearer token rotated — re-pair every device');
    } else {
      io.stderr(`claude-usage configure: unknown setting "${sub}"\n`);
      io.stderr('  configure [service|hook|mcp|statusline|autoupdate] <on|off>\n');
      io.stderr('  configure thresholds --warn N --critical N\n');
      io.stderr('  configure port N | rotate-token | pairing [--json]\n');
      return 1;
    }

    persistConfig(config, ctx.configDir);
    if (changes.length === 0) io.stdout('no changes\n');
    for (const change of changes) io.stdout(`${change}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InstallError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
