import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addHookGroups,
  applySettings,
  backupPathFor,
  HOOK_EVENTS,
  hookCommand,
  readSettingsFile,
  removeSettings,
  SettingsError,
  statuslineCommand,
} from '../../src/install/settings-merge.js';
import { cleanupAllTempHomes, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'install');
const BIN = '/home/example/.local/share/claude-usage/current/bin/claude-usage';

interface Bed {
  file: string;
  original: string;
}

function bed(fixture: 'settings-empty.json' | 'settings-populated.json'): Bed {
  const h = tempHome();
  const file = join(h.home, '.claude', 'settings.json');
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(join(FIXTURES, fixture), file);
  chmodSync(file, 0o644);
  return { file, original: readFileSync(join(FIXTURES, fixture), 'utf8') };
}

function read(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('hook group shape (§23.11)', () => {
  it('appends one group per event, no matcher, with the right timeouts', () => {
    const json: Record<string, unknown> = {};
    const result = addHookGroups(json, BIN);
    expect(result.added).toEqual(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse']);

    const hooks = json['hooks'] as Record<string, unknown[]>;
    for (const { event, timeoutSeconds } of HOOK_EVENTS) {
      expect(hooks[event]).toEqual([
        { hooks: [{ type: 'command', command: `${BIN} hook`, timeout: timeoutSeconds }] },
      ]);
      expect(Object.keys((hooks[event] as unknown[])[0] as object)).not.toContain('matcher');
    }
    expect(hooks['SessionStart']?.length).toBe(1);
    expect((hooks['SessionStart'] as Array<{ hooks: Array<{ timeout: number }> }>)[0]?.hooks[0]?.timeout).toBe(5);
    expect((hooks['PreToolUse'] as Array<{ hooks: Array<{ timeout: number }> }>)[0]?.hooks[0]?.timeout).toBe(86_400);
  });
});

describe('empty settings.json', () => {
  it('round-trips: install → uninstall is byte-identical to the fixture', () => {
    const b = bed('settings-empty.json');
    applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    expect(readFileSync(b.file, 'utf8')).not.toBe(b.original);

    removeSettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    expect(readFileSync(b.file, 'utf8')).toBe(b.original);
  });

  it('sets statusLine when none exists', () => {
    const b = bed('settings-empty.json');
    const r = applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    expect(r.statusLine?.outcome).toBe('set');
    expect(read(b.file)['statusLine']).toEqual({ type: 'command', command: statuslineCommand(BIN) });
  });
});

describe('populated settings.json', () => {
  it('leaves untouched keys byte-identical and appends rather than replacing groups', () => {
    const b = bed('settings-populated.json');
    const before = read(b.file);
    applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    const after = read(b.file);

    for (const key of ['model', 'includeCoAuthoredBy', 'permissions', 'env', 'someUnknownFutureKey']) {
      expect(JSON.stringify(after[key]), key).toBe(JSON.stringify(before[key]));
    }
    // the user's own statusLine wins; we only print the snippet
    expect(after['statusLine']).toEqual(before['statusLine']);

    const hooks = after['hooks'] as Record<string, unknown[]>;
    const hooksBefore = before['hooks'] as Record<string, unknown[]>;
    // existing groups survive, ours is appended last
    expect(hooks['PreToolUse']?.length).toBe((hooksBefore['PreToolUse'] ?? []).length + 1);
    expect(JSON.stringify(hooks['PreToolUse']?.slice(0, 2))).toBe(JSON.stringify(hooksBefore['PreToolUse']));
    expect(hooks['SessionStart']?.length).toBe(2);
    // PostToolUse is not one of ours — untouched
    expect(JSON.stringify(hooks['PostToolUse'])).toBe(JSON.stringify(hooksBefore['PostToolUse']));
    // events that were absent get created
    expect(hooks['SessionEnd']?.length).toBe(1);
    expect(hooks['UserPromptSubmit']?.length).toBe(1);
  });

  it('reports the snippet instead of overwriting an existing statusLine', () => {
    const b = bed('settings-populated.json');
    const r = applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    expect(r.statusLine?.outcome).toBe('other-exists');
    expect(r.statusLine?.snippet).toBe(`${BIN} statusline`);
  });

  it('is idempotent on re-run', () => {
    const b = bed('settings-populated.json');
    applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    const afterFirst = readFileSync(b.file, 'utf8');

    const second = applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    expect(second.changed).toBe(false);
    expect(second.hooksAdded).toEqual([]);
    expect(second.hooksAlreadyPresent).toEqual(HOOK_EVENTS.map((h) => h.event));
    expect(readFileSync(b.file, 'utf8')).toBe(afterFirst);
  });

  it('round-trips: install → uninstall is byte-identical except for the .bak', () => {
    const b = bed('settings-populated.json');
    applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    removeSettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    expect(readFileSync(b.file, 'utf8')).toBe(b.original);
    expect(readFileSync(backupPathFor(b.file), 'utf8')).toBe(b.original);
  });
});

describe('.bak', () => {
  it('is written once, copies the source mode, and is never overwritten', () => {
    const b = bed('settings-populated.json');
    chmodSync(b.file, 0o600);

    const first = applySettings({ file: b.file, binPath: BIN, hook: true, statusline: false });
    const backup = backupPathFor(b.file);
    expect(first.backupPath).toBe(backup);
    expect(readFileSync(backup, 'utf8')).toBe(b.original);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    // the settings file itself keeps its mode through the atomic write
    expect(statSync(b.file).mode & 0o777).toBe(0o600);

    // a second, changing run must not clobber the backup
    writeFileSync(b.file, '{}\n');
    const second = applySettings({ file: b.file, binPath: BIN, hook: true, statusline: false });
    expect(second.backupPath).toBeNull();
    expect(readFileSync(backup, 'utf8')).toBe(b.original);
  });

  it('is not written when there is no settings file at all', () => {
    const h = tempHome();
    const file = join(h.home, '.claude', 'settings.json');
    const r = applySettings({ file, binPath: BIN, hook: true, statusline: true });
    expect(r.backupPath).toBeNull();
    expect(existsSync(backupPathFor(file))).toBe(false);
    expect(read(file)['hooks']).toBeDefined();
  });
});

describe('malformed settings.json', () => {
  it('aborts naming the path and writes nothing', () => {
    const h = tempHome();
    const file = join(h.home, '.claude', 'settings.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ "hooks": [ oops\n');

    expect(() => applySettings({ file, binPath: BIN, hook: true, statusline: true })).toThrowError(SettingsError);
    try {
      applySettings({ file, binPath: BIN, hook: true, statusline: true });
    } catch (err) {
      expect((err as SettingsError).message).toContain(file);
    }
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": [ oops\n');
    expect(existsSync(backupPathFor(file))).toBe(false);
  });

  it('rejects a top-level array', () => {
    const h = tempHome();
    const file = join(h.home, '.claude', 'settings.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '[]\n');
    expect(() => readSettingsFile(file)).toThrowError(SettingsError);
  });
});

describe('removal is surgical', () => {
  it('removes only our groups and only our statusLine', () => {
    const b = bed('settings-populated.json');
    applySettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    removeSettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    const after = read(b.file);
    expect(after['statusLine']).toEqual({
      type: 'command',
      command: '/home/example/.claude/statusline.sh',
      padding: 0,
    });
    const hooks = after['hooks'] as Record<string, unknown[]>;
    expect(hooks['PreToolUse']?.length).toBe(2);
    expect(JSON.stringify(hooks)).not.toContain(hookCommand(BIN));
  });

  it('removes our statusLine when it is ours', () => {
    const b = bed('settings-empty.json');
    applySettings({ file: b.file, binPath: BIN, hook: false, statusline: true });
    expect(read(b.file)['statusLine']).toBeDefined();
    const r = removeSettings({ file: b.file, binPath: BIN, hook: false, statusline: true });
    expect(r.statusLineRemoved).toBe(true);
    expect(read(b.file)['statusLine']).toBeUndefined();
  });

  it('is a no-op when there is no settings file', () => {
    const h = tempHome();
    const file = join(h.home, '.claude', 'settings.json');
    const r = removeSettings({ file, binPath: BIN, hook: true, statusline: true });
    expect(r.changed).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('ignores groups belonging to a different install path', () => {
    const b = bed('settings-empty.json');
    applySettings({ file: b.file, binPath: '/other/bin/claude-usage', hook: true, statusline: true });
    const before = readFileSync(b.file, 'utf8');
    const r = removeSettings({ file: b.file, binPath: BIN, hook: true, statusline: true });
    expect(r.changed).toBe(false);
    expect(readFileSync(b.file, 'utf8')).toBe(before);
  });
});
