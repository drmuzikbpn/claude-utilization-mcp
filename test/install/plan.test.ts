import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  confirmPlan,
  defaultFlags,
  InstallError,
  parseInstallArgs,
  parseYesNo,
  planToIntegrations,
  renderPlan,
  type PlanContext,
} from '../../src/install/plan.js';
import { scriptedPrompter } from './helpers.js';

const ctx: PlanContext = {
  serviceKind: 'launchd',
  unitPath: '/home/example/Library/LaunchAgents/com.github.drmuzikbpn.claude-usage.plist',
  settingsFile: '/home/example/.claude/settings.json',
  claudeJsonFile: '/home/example/.claude.json',
  binPath: '/home/example/.local/share/claude-usage/current/bin/claude-usage',
  versionDir: '/home/example/.local/share/claude-usage/versions/1.2.3',
};

describe('parseInstallArgs', () => {
  it('defaults to service/hook/mcp and the limits feed on, the visible status line off (§23.54)', () => {
    expect(parseInstallArgs([])).toEqual(defaultFlags());
    const d = parseInstallArgs([]);
    expect([d.service, d.hook, d.mcp, d.feed, d.statusline]).toEqual([true, true, true, true, false]);
  });

  it('--no-statusline leaves statusLine alone entirely', () => {
    const f = parseInstallArgs(['--no-statusline']);
    expect([f.feed, f.statusline]).toEqual([false, false]);
    expect(planToIntegrations(buildPlan(f, ctx)).statusline).toBe(false);
  });

  it('honours every flag', () => {
    const f = parseInstallArgs(['--yes', '--no-service', '--no-hook', '--no-mcp', '--statusline', '--tailscale', '--lan', '--linger']);
    expect(f).toEqual({
      yes: true,
      service: false,
      hook: false,
      mcp: false,
      statusline: true,
      feed: true,
      tailscale: true,
      lan: true,
      linger: true,
      unknown: [],
    });
    expect(parseInstallArgs(['-y']).yes).toBe(true);
  });

  it('collects unknown options rather than guessing', () => {
    expect(parseInstallArgs(['--wat', 'x']).unknown).toEqual(['--wat', 'x']);
  });
});

describe('plan rendering', () => {
  it('shows every item with its target and a checkbox', () => {
    const text = renderPlan(buildPlan(parseInstallArgs([]), ctx), ctx);
    expect(text).toContain(ctx.versionDir);
    expect(text).toContain(ctx.binPath);
    expect(text).toContain('[x] background service');
    expect(text).toContain('[x] Claude Code hooks');
    expect(text).toContain('[x] MCP server');
    expect(text).toContain('[x] live limits');
    // Says what it reads and that it draws nothing, before anything is written.
    expect(text).toContain('only the rate-limit percentages');
    expect(text).toContain('prints nothing');
    expect(text).toContain(ctx.unitPath);
    expect(text).toContain('SessionStart, SessionEnd, UserPromptSubmit, PreToolUse');
  });

  it('marks the service unavailable when there is no service manager', () => {
    const noop: PlanContext = { ...ctx, serviceKind: 'noop', unitPath: '' };
    const items = buildPlan(parseInstallArgs([]), noop);
    expect(items[0]?.enabled).toBe(false);
    expect(renderPlan(items, noop)).toContain('no supported service manager');
  });
});

describe('confirmPlan', () => {
  it('--yes accepts the defaults without asking', async () => {
    const scripted = scriptedPrompter([]);
    const items = await confirmPlan(buildPlan(parseInstallArgs([]), ctx), {
      yes: true,
      isTTY: true,
      prompt: scripted.prompt,
    });
    expect(scripted.questions).toEqual([]);
    expect(planToIntegrations(items)).toEqual({ service: true, hook: true, mcp: true, statusline: true });
  });

  it('asks once per item and returns the answers', async () => {
    const scripted = scriptedPrompter([false, true, false, true]);
    const items = await confirmPlan(buildPlan(parseInstallArgs([]), ctx), {
      yes: false,
      isTTY: true,
      prompt: scripted.prompt,
    });
    expect(scripted.questions).toHaveLength(4);
    expect(planToIntegrations(items)).toEqual({ service: false, hook: true, mcp: false, statusline: true });
  });

  it('never offers a service it cannot install', async () => {
    const noop: PlanContext = { ...ctx, serviceKind: 'noop', unitPath: '' };
    const scripted = scriptedPrompter([true, true, true, true]);
    const items = await confirmPlan(buildPlan(parseInstallArgs([]), noop), {
      yes: false,
      isTTY: true,
      prompt: scripted.prompt,
    });
    expect(planToIntegrations(items).service).toBe(false);
    expect(scripted.questions).not.toContain('background service?');
  });

  it('fails on a non-TTY without --yes', async () => {
    await expect(confirmPlan(buildPlan(parseInstallArgs([]), ctx), { yes: false, isTTY: false })).rejects.toBeInstanceOf(
      InstallError,
    );
  });
});

describe('parseYesNo', () => {
  it('treats an empty answer as the default', () => {
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo('  ', false)).toBe(false);
  });

  it('accepts y/yes in any case and treats everything else as no', () => {
    for (const yes of ['y', 'Y', 'yes', 'YES', ' Yes ']) expect(parseYesNo(yes, false)).toBe(true);
    for (const no of ['n', 'no', 'nope', 'x']) expect(parseYesNo(no, true)).toBe(false);
  });
});
