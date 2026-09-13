/** `claude-usage sessions | pause | resume` (§18.4's CLI mirrors). */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonFilePath } from '../../src/clients/http.js';
import { run } from '../../src/cli.js';
import { saveConfig, writeJsonFile } from '../../src/config.js';
import { pauseFilePath } from '../../src/pause/rules.js';
import { sessionsFilePath } from '../../src/sessions/registry.js';
import type { UsageServer } from '../../src/server/index.js';
import { testConfig } from '../helpers/fakes.js';
import { makeHarness, startHarnessServer, tempDir, type Harness } from '../sessions/helpers.js';

let h: Harness;
let server: UsageServer;

async function cli(argv: string[], configDir?: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    configDir: configDir ?? h.configDir,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  });
  return { code, out, err };
}

beforeEach(async () => {
  h = makeHarness();
  const started = await startHarnessServer(h);
  server = started.server;
  saveConfig(testConfig(), h.configDir);
  writeJsonFile(daemonFilePath(h.configDir), {
    pid: process.pid,
    port: started.port,
    startedAt: new Date().toISOString(),
    version: '9.9.9',
  });
});

afterEach(async () => {
  h.subsystem.stop();
  await server.close();
});

describe('claude-usage sessions', () => {
  it('prints a table of live sessions', async () => {
    h.subsystem.registry.register({
      sessionId: 'abcdef0123456789',
      pid: 4242,
      cwd: '/tmp/x/foo-wt2',
      gitCommonDir: '/tmp/x/foo/.git',
    });
    h.alive.add(4242);
    h.subsystem.registry.checkLiveness();

    const r = await cli(['sessions']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('abcdef01');
    expect(r.out).toContain('foo @ foo-wt2');
    expect(r.out).toContain('4242');
    expect(r.out).toContain('alive');
    expect(r.out).toContain(`rev ${h.subsystem.registry.rev}`);
  });

  it('says so when there is nothing running', async () => {
    const r = await cli(['sessions']);
    expect(r.out).toBe('no sessions\n');
  });

  it('exits 1 with no daemon', async () => {
    const r = await cli(['sessions'], tempDir('cu-cli-'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('daemon');
  });
});

describe('claude-usage pause / resume', () => {
  it('pauses with the token from config.json and lists the affected sessions', async () => {
    h.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp/x/foo' });
    const r = await cli(['pause', 'all', '--reason', 'dinner']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('paused all (soft)');
    expect(r.out).toContain('affected: sess-1');
    const rules = h.subsystem.rules.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.reason).toBe('dinner');
    expect(rules[0]?.createdBy).toBe('dashboard');
  });

  it('passes --hard through', async () => {
    h.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp/x/foo' });
    h.alive.add(4242);
    const r = await cli(['pause', 'session:sess-1', '--hard']);
    // The fake process table has no such pid, so the daemon refuses (410, §18.3)
    // and the CLI surfaces the daemon's own message.
    expect(r.code).toBe(1);
    expect(r.err).toContain('is gone');
    expect(h.subsystem.rules.list()).toEqual([]);
  });

  it('rejects a bad scope without calling the daemon', async () => {
    const bad = await cli(['pause', 'everything']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('all | project:<path> | session:<id>');
    expect(await cli(['resume'])).toMatchObject({ code: 1 });
  });

  it('resumes one scope', async () => {
    h.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp/x/foo' });
    await cli(['pause', 'all']);
    const r = await cli(['resume', 'all']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('removed 1 rule(s)');
    expect(r.out).toContain('sess-1');
    expect(h.subsystem.rules.list()).toEqual([]);
  });

  it('resume --all clears every rule through the daemon', async () => {
    h.subsystem.registry.register({ sessionId: 'sess-1', pid: 4242, cwd: '/tmp/x/foo' });
    await cli(['pause', 'all']);
    await cli(['pause', 'session:sess-1']);
    expect(h.subsystem.rules.list()).toHaveLength(2);

    const r = await cli(['resume', '--all']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('removed 2 rule(s)');
    expect(h.subsystem.rules.list()).toEqual([]);
  });

  it('resume --all works with the daemon dead (§18.3 escape hatch)', async () => {
    const configDir = tempDir('cu-offline-');
    saveConfig(testConfig(), configDir);
    writeJsonFile(sessionsFilePath(configDir), {
      version: 1,
      rev: 4,
      sessions: [
        {
          sessionId: 'sess-1',
          pid: 2_147_483_646,
          cwd: '/tmp/x/foo',
          transcriptPath: null,
          gitCommonDir: null,
          source: null,
          registeredAt: '2026-09-13T12:00:00.000Z',
          lastActivityAt: '2026-09-13T12:00:00.000Z',
          alive: true,
          deadSince: null,
          frozenPids: [2_147_483_646],
          pausedSince: '2026-09-13T12:00:00.000Z',
          lastTool: null,
        },
      ],
    });
    writeJsonFile(pauseFilePath(configDir), {
      version: 1,
      rules: [
        { id: 'r_offline', scope: 'all', mode: 'hard', reason: '', createdAt: '2026-09-13T12:00:00.000Z', createdBy: 'cli' },
      ],
    });

    const r = await cli(['resume', '--all'], configDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('resumed offline');
    expect(r.out).toContain('1 rule(s) cleared');
    const rules = JSON.parse(readFileSync(pauseFilePath(configDir), 'utf8')) as { rules: unknown[] };
    expect(rules.rules).toEqual([]);
    const sessions = JSON.parse(readFileSync(sessionsFilePath(configDir), 'utf8')) as {
      sessions: { frozenPids: number[] }[];
    };
    expect(sessions.sessions[0]?.frozenPids).toEqual([]);
  });
});
