import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_EVENTS, ourHookGroup, statuslineCommand } from '../../src/install/settings-merge.js';
import { createServer, type UsageServer } from '../../src/server/index.js';
import { createInstallReader, INSTALL_CACHE_MS, type InstallPaths } from '../../src/server/install-state.js';
import { FakeLimitsProvider, FakeTokensSource, testConfig } from '../helpers/fakes.js';
import { rawRequest } from '../helpers/raw-request.js';

function paths(): InstallPaths & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cu-inst-'));
  mkdirSync(join(dir, '.claude'));
  return {
    dir,
    settingsFile: join(dir, '.claude', 'settings.json'),
    claudeJsonFile: join(dir, '.claude.json'),
    binPath: join(dir, 'current', 'bin', 'claude-usage'),
  };
}

function writeSettings(p: InstallPaths, json: unknown): void {
  writeFileSync(p.settingsFile, JSON.stringify(json));
}

const allHooks = (bin: string): Record<string, unknown> =>
  Object.fromEntries(HOOK_EVENTS.map((h) => [h.event, [ourHookGroup(bin, h.timeoutSeconds)]]));

describe('createInstallReader (§23.48)', () => {
  it('reports nothing installed on a bare machine, without throwing', () => {
    const p = paths();
    expect(createInstallReader(p)()).toEqual({ hooks: false, statusline: 'none', mcp: false });
  });

  it('hooks: true only when every event has our group', () => {
    const p = paths();
    writeSettings(p, { hooks: allHooks(p.binPath) });
    expect(createInstallReader(p)().hooks).toBe(true);
    const partial = allHooks(p.binPath);
    delete partial['PreToolUse'];
    writeSettings(p, { hooks: partial });
    expect(createInstallReader(p)().hooks).toBe(false);
  });

  it('statusline: ours, includes-ours (inline or in a script), other', () => {
    const p = paths();
    writeSettings(p, { statusLine: { type: 'command', command: statuslineCommand(p.binPath) } });
    expect(createInstallReader(p)().statusline).toBe('ours');

    writeSettings(p, { statusLine: { type: 'command', command: `bash -c 'x | ${p.binPath} observe; mine'` } });
    expect(createInstallReader(p)().statusline).toBe('includes-ours');

    const script = join(p.dir, 'statusline.sh');
    writeFileSync(script, '#!/bin/sh\ntee >(claude-usage observe)\n');
    writeSettings(p, { statusLine: { type: 'command', command: `${script} --flag` } });
    expect(createInstallReader(p)().statusline).toBe('includes-ours');

    writeFileSync(script, '#!/bin/sh\necho hi\n');
    expect(createInstallReader(p)().statusline).toBe('other');
  });

  it('mcp: true / false, and null when ~/.claude.json is unreadable', () => {
    const p = paths();
    writeFileSync(p.claudeJsonFile, JSON.stringify({ mcpServers: { 'claude-usage': { type: 'stdio' } } }));
    expect(createInstallReader(p)().mcp).toBe(true);
    writeFileSync(p.claudeJsonFile, JSON.stringify({ mcpServers: {} }));
    expect(createInstallReader(p)().mcp).toBe(false);
    writeFileSync(p.claudeJsonFile, '{ not json');
    expect(createInstallReader(p)().mcp).toBeNull();
  });

  it('malformed settings read as not installed, never a throw', () => {
    const p = paths();
    writeFileSync(p.settingsFile, '{ nope');
    expect(createInstallReader(p)()).toMatchObject({ hooks: false, statusline: 'none' });
  });

  it('caches file reads for 60 s', () => {
    const p = paths();
    let t = 0;
    const read = createInstallReader(p, () => t);
    expect(read().hooks).toBe(false);
    writeSettings(p, { hooks: allHooks(p.binPath) });
    t = INSTALL_CACHE_MS - 1;
    expect(read().hooks).toBe(false);
    t = INSTALL_CACHE_MS;
    expect(read().hooks).toBe(true);
  });
});

const started: UsageServer[] = [];
afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

describe('/health.install (§23.48)', () => {
  it('carries the install block with live listeners and no file paths', async () => {
    const p = paths();
    writeSettings(p, { hooks: allHooks(p.binPath) });
    const server = createServer({
      config: testConfig(),
      limits: new FakeLimitsProvider(),
      tokens: new FakeTokensSource(),
      version: '9.9.9',
      install: p,
    });
    started.push(server);
    const port = await server.listen(0, '127.0.0.1');
    const res = await rawRequest({ port, path: '/health' });
    const body = JSON.parse(res.body) as { install: unknown };
    expect(body.install).toEqual({
      hooks: true,
      statusline: 'none',
      mcp: false,
      listeners: [{ addr: '127.0.0.1', port, tls: false }],
    });
    expect(res.body).not.toContain(p.dir);
  });
});
