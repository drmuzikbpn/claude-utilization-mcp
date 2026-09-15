import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addMcpServer,
  FALLBACK_WARNING,
  MCP_KEY,
  mcpEntry,
  removeMcpServer,
} from '../../src/install/claude-json.js';
import { claudeJsonPath } from '../../src/paths.js';
import { cleanupAllTempHomes, fakeExec, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

const BIN = '/home/example/.local/share/claude-usage/current/bin/claude-usage';

/** Something that looks like Claude Code's live state file. */
const LIVE_STATE = {
  numStartups: 412,
  installMethod: 'native',
  oauthAccount: { emailAddress: 'user@example.test', accountUuid: '00000000-0000-4000-8000-000000000000' },
  mcpServers: {
    'some-other-server': { type: 'stdio', command: '/usr/local/bin/other-mcp', args: [] },
  },
  projects: { '/home/example/code/demo': { allowedTools: [] } },
};

function withClaudeJson(body: unknown = LIVE_STATE): { file: string; home: string } {
  const h = tempHome();
  const file = claudeJsonPath(h.env);
  if (body !== undefined) {
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return { file, home: h.home };
}

describe('primary path — claude mcp add/remove', () => {
  it('delegates the write and never touches the file', async () => {
    const { file } = withClaudeJson();
    const before = readFileSync(file, 'utf8');
    const exec = fakeExec();

    const r = await addMcpServer({ file, binPath: BIN, exec: exec.runner });
    expect(r.method).toBe('claude-cli');
    expect(r.warning).toBeNull();
    expect(exec.lines()).toEqual([`claude mcp add --scope user ${MCP_KEY} -- ${BIN} mcp`]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('removes via the CLI', async () => {
    const { file } = withClaudeJson();
    const before = readFileSync(file, 'utf8');
    const exec = fakeExec();
    const r = await removeMcpServer({ file, binPath: BIN, exec: exec.runner });
    expect(r.method).toBe('claude-cli');
    expect(exec.lines()).toEqual([`claude mcp remove --scope user ${MCP_KEY}`]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('treats "no such server" on remove as already-done, not an error', async () => {
    const { file } = withClaudeJson();
    const exec = fakeExec(() => ({ code: 1, stderr: 'No MCP server found' }));
    const r = await removeMcpServer({ file, binPath: BIN, exec: exec.runner });
    expect(r.changed).toBe(false);
  });

  it('surfaces a genuine `claude mcp add` failure', async () => {
    const { file } = withClaudeJson();
    const exec = fakeExec(() => ({ code: 2, stderr: 'boom' }));
    await expect(addMcpServer({ file, binPath: BIN, exec: exec.runner })).rejects.toThrow(/exit 2/);
  });
});

describe('fallback path — no claude on PATH', () => {
  const missing = () => fakeExec(() => ({ code: 127 }));

  it('merges the stdio entry, preserves 0600 and writes no .bak', async () => {
    const { file, home } = withClaudeJson();
    const r = await addMcpServer({ file, binPath: BIN, exec: missing().runner });

    expect(r.method).toBe('fallback');
    expect(r.changed).toBe(true);
    expect(r.warning).toBe(FALLBACK_WARNING);

    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(json['mcpServers']?.[MCP_KEY]).toEqual(mcpEntry(BIN));
    expect(json['mcpServers']?.[MCP_KEY]).toMatchObject({ type: 'stdio', command: BIN, args: ['mcp'] });
    // unrelated state survives
    expect(json['mcpServers']?.['some-other-server']).toEqual(LIVE_STATE.mcpServers['some-other-server']);
    expect(json['numStartups']).toBe(412);
    expect(json['projects']).toEqual(LIVE_STATE.projects);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((n) => n.includes('.bak'))).toEqual([]);
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the file at 0600 when it does not exist', async () => {
    const h = tempHome();
    const file = claudeJsonPath(h.env);
    await addMcpServer({ file, binPath: BIN, exec: missing().runner });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(json['mcpServers']?.[MCP_KEY]).toEqual(mcpEntry(BIN));
  });

  it('is idempotent', async () => {
    const { file } = withClaudeJson();
    await addMcpServer({ file, binPath: BIN, exec: missing().runner });
    const once = readFileSync(file, 'utf8');
    const second = await addMcpServer({ file, binPath: BIN, exec: missing().runner });
    expect(second.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('removes only our key and leaves the rest of the file alone', async () => {
    const { file } = withClaudeJson();
    const before = readFileSync(file, 'utf8');
    await addMcpServer({ file, binPath: BIN, exec: missing().runner });
    const r = await removeMcpServer({ file, binPath: BIN, exec: missing().runner });
    expect(r.changed).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('drops an mcpServers object that we created and then emptied', async () => {
    const { file } = withClaudeJson({ numStartups: 1 });
    await addMcpServer({ file, binPath: BIN, exec: missing().runner });
    await removeMcpServer({ file, binPath: BIN, exec: missing().runner });
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify({ numStartups: 1 }, null, 2)}\n`);
  });

  it('aborts on malformed JSON', async () => {
    const h = tempHome();
    const file = claudeJsonPath(h.env);
    writeFileSync(file, '{ nope', { mode: 0o600 });
    await expect(addMcpServer({ file, binPath: BIN, exec: missing().runner })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ nope');
  });

  it('removal is a no-op when the file is absent', async () => {
    const h = tempHome();
    const file = join(h.home, '.claude.json');
    const r = await removeMcpServer({ file, binPath: BIN, exec: missing().runner });
    expect(r.changed).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

/**
 * §23.29, reported from the Mac Studio's second desktop install:
 *
 *     Error: `claude mcp add --scope user claude-usage -- .../claude-usage mcp` failed
 *     (exit 1): MCP server claude-usage already exists in user config
 *
 * It aborted `runInstall` *after* the service was installed and before the status table and
 * every note — so the machine was configured and said nothing about the one thing the user
 * had gone to the desktop to check.
 */
describe('addMcpServer idempotency (§23.29)', () => {
  it('treats "already exists" as the end state it asked for, not a failure', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) =>
      f === 'claude' && a[0] === 'mcp' && a[1] === 'add'
        ? { code: 1, stderr: 'MCP server claude-usage already exists in user config' }
        : undefined,
    );
    const result = await addMcpServer({
      file: join(h.home, '.claude.json'),
      binPath: '/data/claude-usage/current/bin/claude-usage',
      exec: exec.runner,
    });
    expect(result.method).toBe('claude-cli');
    expect(result.warning).toBeNull();
    // No fallback write: the entry is already there and points at the stable `current` path.
    expect(existsSync(join(h.home, '.claude.json'))).toBe(false);
  });

  it('still throws on a real failure rather than swallowing everything', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) =>
      f === 'claude' && a[0] === 'mcp' && a[1] === 'add'
        ? { code: 1, stderr: 'error: could not write config' }
        : undefined,
    );
    await expect(
      addMcpServer({
        file: join(h.home, '.claude.json'),
        binPath: '/data/claude-usage/current/bin/claude-usage',
        exec: exec.runner,
      }),
    ).rejects.toThrow(/could not write config/);
  });
});

