import { versionDir } from '../paths.js';
import { buildUnit } from '../service/index.js';
import { addMcpServer } from './claude-json.js';
import {
  asSystemd,
  loadConfigWithToken,
  persistConfig,
  resolveContext,
  verifyHealth,
  type InstallIO,
} from './context.js';
import {
  buildPlan,
  confirmPlan,
  InstallError,
  parseInstallArgs,
  planToIntegrations,
  renderPlan,
  type PlanContext,
} from './plan.js';
import { preflight, renderPreflight } from './preflight.js';
import { applySettings } from './settings-merge.js';
import { installVersion } from './versions.js';
import { ensureRuntimeDeps } from './deps.js';

/** `claude-usage install` (§8). Returns the process exit code; never calls `process.exit`. */
export async function runInstall(argv: readonly string[], io: InstallIO): Promise<number> {
  const flags = parseInstallArgs(argv);
  if (flags.unknown.length > 0) {
    io.stderr(`claude-usage install: unknown option "${flags.unknown[0] ?? ''}"\n`);
    return 1;
  }

  const ctx = await resolveContext(io);

  // 1. Preflight — the Keychain notice is printed before the first credential read.
  const pre = await preflight({
    platform: ctx.platform,
    notify: (line) => io.stdout(`\n${line}\n\n`),
    ...(io.readCredentials === undefined ? {} : { readCredentials: io.readCredentials }),
  });
  io.stdout('preflight\n');
  io.stdout(renderPreflight(pre));
  if (!pre.ok) {
    io.stderr('claude-usage install: preflight failed — nothing was changed\n');
    return 1;
  }

  // 2. Plan + confirm.
  const planCtx: PlanContext = {
    serviceKind: ctx.service.kind,
    unitPath: ctx.service.unitPath,
    settingsFile: ctx.settingsFile,
    claudeJsonFile: ctx.claudeJsonFile,
    binPath: ctx.binPath,
    versionDir: versionDir(ctx.version, ctx.env),
  };
  const items = buildPlan(flags, planCtx);
  io.stdout(`\n${renderPlan(items, planCtx)}\n`);

  let confirmed;
  try {
    confirmed = await confirmPlan(items, {
      yes: flags.yes,
      isTTY: io.isTTY ?? process.stdout.isTTY === true,
      ...(io.prompt === undefined ? {} : { prompt: io.prompt }),
    });
  } catch (err) {
    if (err instanceof InstallError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const chosen = planToIntegrations(confirmed);

  // 3. Config: mint the bearer token if there is none, record the choices, 0600.
  const { config, minted } = loadConfigWithToken(ctx.configDir, io.randomToken);
  config.integrations = { ...config.integrations, ...chosen };
  if (flags.tailscale && !config.bind.includes('tailscale')) config.bind = [...config.bind, 'tailscale'];
  persistConfig(config, ctx.configDir);
  io.stdout(`\nconfig: ${ctx.configDir}/config.json (0600)${minted ? ' — bearer token generated' : ''}\n`);

  // 4. Versions layout: copy the package, repoint `current` (§20).
  const version = installVersion({
    version: ctx.version,
    env: ctx.env,
    ...(io.sourceDir === undefined ? {} : { sourceDir: io.sourceDir }),
  });
  const depsInstalled = await ensureRuntimeDeps(version.versionDir, ctx.exec ?? undefined);
  io.stdout(
    `package: ${version.versionDir}${version.copied ? '' : ' (already installed)'}${depsInstalled ? ' — production deps installed' : ''}\n` +
      `current: ${version.currentLink} -> ${version.versionDir}\n`,
  );

  // 5. Apply.
  const notes: string[] = [];
  if (chosen.service) {
    await ctx.service.install(buildUnit({ nodePath: ctx.nodePath, binPath: ctx.binPath, env: ctx.env }));
    io.stdout(`service: ${ctx.service.kind} ${ctx.service.unitPath}\n`);
    if (flags.linger) {
      const systemd = asSystemd(ctx.service);
      if (systemd === null) notes.push('--linger only applies to systemd; ignored');
      else {
        const report = await systemd.enableLinger();
        notes.push(report.message);
      }
    }
  }

  if (chosen.hook || chosen.statusline) {
    const result = applySettings({
      file: ctx.settingsFile,
      binPath: ctx.binPath,
      hook: chosen.hook,
      statusline: chosen.statusline,
    });
    if (chosen.hook) {
      io.stdout(
        `hooks:   ${result.hooksAdded.length > 0 ? `registered ${result.hooksAdded.join(', ')}` : 'already registered'}\n`,
      );
    }
    if (result.backupPath !== null) notes.push(`backup written once: ${result.backupPath}`);
    if (result.statusLine?.outcome === 'set') io.stdout('status:  statusLine set\n');
    if (result.statusLine?.outcome === 'other-exists') {
      notes.push(
        `you already have a statusLine — append this to your own script instead:\n    ${result.statusLine.snippet}`,
      );
    }
  }

  if (chosen.mcp) {
    const mcp = await addMcpServer({
      file: ctx.claudeJsonFile,
      binPath: ctx.binPath,
      ...(ctx.exec === undefined ? {} : { exec: ctx.exec }),
    });
    io.stdout(`mcp:     registered via ${mcp.method === 'claude-cli' ? '`claude mcp add`' : 'direct merge'}\n`);
    if (mcp.warning !== null) notes.push(mcp.warning);
  }

  // 6. Verify + status table.
  let healthy = false;
  if (chosen.service) {
    healthy = await verifyHealth(io, ctx.configDir);
    if (!healthy) {
      notes.push(
        `the daemon did not answer GET /health within 5s — check \`claude-usage status\`${
          ctx.service.kind === 'launchd' ? ' or the log under ~/Library/Logs/claude-usage' : ' or `journalctl --user -u claude-usage`'
        }`,
      );
    }
  } else {
    notes.push('no service installed — run `claude-usage serve` yourself, or re-run install without --no-service');
  }

  io.stdout(`\n${await renderStatusTable(ctx, chosen, healthy, config.port)}`);
  for (const note of notes) io.stdout(`\nnote: ${note}\n`);
  return 0;
}

async function renderStatusTable(
  ctx: Awaited<ReturnType<typeof resolveContext>>,
  chosen: Record<string, boolean>,
  healthy: boolean,
  port: number,
): Promise<string> {
  const state = await ctx.service.status();
  const rows: Array<[string, string]> = [
    ['service', chosen['service'] === true ? `${ctx.service.kind} — ${state}` : 'off'],
    ['daemon', healthy ? `healthy on port ${String(port)}` : chosen['service'] === true ? 'not answering' : 'not started'],
    ['hooks', chosen['hook'] === true ? 'on' : 'off'],
    ['mcp', chosen['mcp'] === true ? 'on' : 'off'],
    ['statusline', chosen['statusline'] === true ? 'on' : 'off'],
    ['config', ctx.configDir],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  return `installed\n${rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n')}\n`;
}
