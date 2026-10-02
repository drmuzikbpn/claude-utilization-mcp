import { createInterface } from 'node:readline/promises';

/** Flag parsing, the printed plan and the per-item confirmation (§8 step 2). */

export type PlanKey = 'service' | 'hook' | 'mcp' | 'statusline';

export interface InstallFlags {
  yes: boolean;
  service: boolean;
  hook: boolean;
  mcp: boolean;
  /** The visible status line (§7.3). Implies the feed. */
  statusline: boolean;
  /** The silent limits feed (§23.54): default on, `--no-statusline` turns it off. */
  feed: boolean;
  /** Add `"tailscale"` to `config.bind` (§16). */
  tailscale: boolean;
  /** Add `"lan"` to `config.bind` (§23.44). Interactive install asks, default yes. */
  lan: boolean;
  /** `loginctl enable-linger` on systemd (§23.9). */
  linger: boolean;
  unknown: string[];
}

/** Install refused for a reason the user can act on. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

/** Defaults: service yes, hook yes, MCP yes, limits feed yes, visible status line no (§8, §23.54). */
export function defaultFlags(): InstallFlags {
  return {
    yes: false,
    service: true,
    hook: true,
    mcp: true,
    statusline: false,
    feed: true,
    tailscale: false,
    lan: false,
    linger: false,
    unknown: [],
  };
}

export function parseInstallArgs(argv: readonly string[]): InstallFlags {
  const flags = defaultFlags();
  for (const arg of argv) {
    switch (arg) {
      case '--yes':
      case '-y':
        flags.yes = true;
        break;
      case '--no-service':
        flags.service = false;
        break;
      case '--no-hook':
        flags.hook = false;
        break;
      case '--no-mcp':
        flags.mcp = false;
        break;
      case '--statusline':
        flags.statusline = true;
        flags.feed = true;
        break;
      case '--no-statusline':
        flags.statusline = false;
        flags.feed = false;
        break;
      case '--tailscale':
        flags.tailscale = true;
        break;
      case '--lan':
        flags.lan = true;
        break;
      case '--linger':
        flags.linger = true;
        break;
      default:
        flags.unknown.push(arg);
    }
  }
  return flags;
}

export interface PlanContext {
  serviceKind: 'launchd' | 'systemd' | 'noop';
  unitPath: string;
  settingsFile: string;
  claudeJsonFile: string;
  binPath: string;
  versionDir: string;
  /** What `statusLine` holds today (§23.48); install looks before it plans. Absent = none. */
  statusline?: 'ours' | 'includes-ours' | 'other' | 'none';
}

/** What the limits feed reads, said before anything is written (§23.54). */
const FEED_PRIVACY =
  "reads only the rate-limit percentages Claude Code already computes and hands them to this machine's daemon — no prompts, no paths, nothing leaves this machine";

function limitsDetail(flags: InstallFlags, ctx: PlanContext): string {
  switch (ctx.statusline ?? 'none') {
    case 'ours':
    case 'includes-ours':
      return `${ctx.settingsFile} — statusLine already forwards to claude-usage; nothing to change`;
    case 'other':
      return `${ctx.settingsFile} — you have your own statusLine, which is left alone; install prints one line to add to it\n      ${FEED_PRIVACY}`;
    case 'none':
      return flags.statusline
        ? `${ctx.settingsFile} — statusLine shows "5h 42% · 7d 61%"\n      ${FEED_PRIVACY}`
        : `${ctx.settingsFile} — statusLine (you have none), prints nothing\n      ${FEED_PRIVACY}`;
  }
}

export interface PlanItem {
  key: PlanKey;
  label: string;
  detail: string;
  /** The default answer, which `--yes` accepts. */
  enabled: boolean;
}

export function buildPlan(flags: InstallFlags, ctx: PlanContext): PlanItem[] {
  return [
    {
      key: 'service',
      label: 'background service',
      detail:
        ctx.serviceKind === 'noop'
          ? 'no supported service manager — run `claude-usage serve` yourself'
          : `${ctx.serviceKind}: ${ctx.unitPath}`,
      enabled: flags.service && ctx.serviceKind !== 'noop',
    },
    {
      key: 'hook',
      label: 'Claude Code hooks',
      detail: `${ctx.settingsFile} — SessionStart, SessionEnd, UserPromptSubmit, PreToolUse`,
      enabled: flags.hook,
    },
    { key: 'mcp', label: 'MCP server', detail: `${ctx.claudeJsonFile} — mcpServers["claude-usage"]`, enabled: flags.mcp },
    { key: 'statusline', label: 'live limits', detail: limitsDetail(flags, ctx), enabled: flags.feed || flags.statusline },
  ];
}

export function renderPlan(items: readonly PlanItem[], ctx: PlanContext): string {
  let out = 'claude-usage install plan\n\n';
  out += `  package   → ${ctx.versionDir}\n`;
  out += `  binary    → ${ctx.binPath}\n\n`;
  for (const item of items) {
    out += `  [${item.enabled ? 'x' : ' '}] ${item.label}\n      ${item.detail}\n`;
  }
  return out;
}

/** `(question, defaultYes) => answer`. Injected in tests as a scripted answer list. */
export type Prompter = (question: string, defaultYes: boolean) => Promise<boolean>;

export function parseYesNo(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a.length === 0) return defaultYes;
  return a === 'y' || a === 'yes';
}

/** A real readline prompter. Only used on a TTY. */
export function readlinePrompter(): Prompter {
  return async (question, defaultYes) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`${question} [${defaultYes ? 'Y/n' : 'y/N'}] `);
      return parseYesNo(answer, defaultYes);
    } finally {
      rl.close();
    }
  };
}

export interface ConfirmOptions {
  yes: boolean;
  isTTY: boolean;
  prompt?: Prompter;
}

/**
 * Confirm each item. `--yes` accepts the defaults; a non-TTY without `--yes` is a
 * hard failure rather than a silent default-accept (§8 step 2).
 */
export async function confirmPlan(items: readonly PlanItem[], opts: ConfirmOptions): Promise<PlanItem[]> {
  if (opts.yes) return items.map((i) => ({ ...i }));
  if (!opts.isTTY && opts.prompt === undefined) {
    throw new InstallError(
      'claude-usage install needs a terminal to confirm each step — re-run with --yes to accept the defaults',
    );
  }
  const prompt = opts.prompt ?? readlinePrompter();
  const confirmed: PlanItem[] = [];
  for (const item of items) {
    if (item.key === 'service' && item.detail.startsWith('no supported service manager')) {
      confirmed.push({ ...item, enabled: false });
      continue;
    }
    confirmed.push({ ...item, enabled: await prompt(`${item.label}?`, item.enabled) });
  }
  return confirmed;
}

/** `{ service: true, hook: false, … }` from a confirmed plan. */
export function planToIntegrations(items: readonly PlanItem[]): Record<PlanKey, boolean> {
  const out: Record<PlanKey, boolean> = { service: false, hook: false, mcp: false, statusline: false };
  for (const item of items) out[item.key] = item.enabled;
  return out;
}
