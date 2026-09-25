import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  configPath,
  defaultConfig,
  expandHome,
  loadConfig,
  redactConfig,
  resolveConfigDir,
  saveConfig,
  validateConfig,
} from '../src/config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cu-config-'));
}

describe('resolveConfigDir', () => {
  it('respects XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/claude-usage');
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or empty', () => {
    expect(resolveConfigDir({})).toMatch(/\.config\/claude-usage$/);
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '' })).toMatch(/\.config\/claude-usage$/);
  });
});

describe('expandHome', () => {
  it('expands a leading tilde only', () => {
    expect(expandHome('~/x')).not.toContain('~');
    expect(expandHome('/abs/~/x')).toBe('/abs/~/x');
  });
});

describe('defaults', () => {
  it('matches the documented §9 + §21 defaults', () => {
    const d = defaultConfig();
    expect(d.port).toBe(47291);
    expect(d.pollIntervalMs).toBe(300_000);
    expect(d.thresholds).toEqual({ warn: 80, critical: 95 });
    expect(d.hookDebounceMinutes).toBe(10);
    expect(d.retentionDays).toBe(90);
    expect(d.projectsDir).toBe('~/.claude/projects');
    expect(d.integrations).toEqual({ service: true, hook: true, mcp: true, statusline: false });
    expect(d.bind).toEqual(['127.0.0.1']);
    expect(d.auth.token).toBe('');
    expect(d.events.maxClients).toBe(16);
    expect(d.autoUpdate.enabled).toBe(true);
    expect(typeof d.name).toBe('string');
  });

  it('loadConfig returns defaults when the file is missing', () => {
    const dir = tempDir();
    expect(loadConfig(dir).port).toBe(47291);
  });
});

describe('unknown keys', () => {
  it('are preserved at the top level through a load/save round-trip', () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), JSON.stringify({ port: 1234, futureKey: { a: 1 } }));
    const cfg = loadConfig(dir);
    expect(cfg.port).toBe(1234);
    expect(cfg['futureKey']).toEqual({ a: 1 });
    saveConfig(cfg, dir);
    const reread: unknown = JSON.parse(readFileSync(configPath(dir), 'utf8'));
    expect((reread as Record<string, unknown>)['futureKey']).toEqual({ a: 1 });
  });

  it('are preserved inside known sections', () => {
    const cfg = validateConfig({ thresholds: { warn: 50, futureThreshold: 7 }, integrations: { extra: 'x' } });
    expect(cfg.thresholds.warn).toBe(50);
    expect((cfg.thresholds as unknown as Record<string, unknown>)['futureThreshold']).toBe(7);
    expect((cfg.integrations as unknown as Record<string, unknown>)['extra']).toBe('x');
  });
});

describe('validation', () => {
  const cases: Array<[string, unknown, string]> = [
    ['port', { port: 'no' }, 'port'],
    ['port range', { port: 999_999 }, 'port'],
    ['pollIntervalMs', { pollIntervalMs: 10 }, 'pollIntervalMs'],
    ['thresholds.warn', { thresholds: { warn: 101 } }, 'thresholds.warn'],
    ['thresholds.critical', { thresholds: { critical: -1 } }, 'thresholds.critical'],
    ['warn > critical', { thresholds: { warn: 99, critical: 10 } }, 'thresholds.warn'],
    ['integrations.hook', { integrations: { hook: 'yes' } }, 'integrations.hook'],
    ['projectsDir', { projectsDir: 3 }, 'projectsDir'],
    ['bind', { bind: 'x' }, 'bind'],
    ['bind entry', { bind: [''] }, 'bind[0]'],
    ['retentionDays', { retentionDays: 0 }, 'retentionDays'],
    ['events.maxClients', { events: { maxClients: 0 } }, 'events.maxClients'],
    ['autoUpdate.enabled', { autoUpdate: { enabled: 1 } }, 'autoUpdate.enabled'],
  ];

  for (const [label, input, key] of cases) {
    it(`rejects ${label} and names the key`, () => {
      let thrown: unknown;
      try {
        validateConfig(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).key).toBe(key);
      expect((thrown as ConfigError).message).toContain(key);
    });
  }

  it('rejects a non-object config body', () => {
    expect(() => validateConfig([1, 2])).toThrow(ConfigError);
  });

  it('rejects invalid JSON naming the file', () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), '{oops');
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
  });
});

describe('file modes', () => {
  it('writes config 0600 inside a 0700 directory', () => {
    const base = tempDir();
    const dir = join(base, 'nested', 'claude-usage');
    saveConfig(defaultConfig(), dir);
    expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens the mode of a pre-existing loose directory', () => {
    const base = tempDir();
    const dir = join(base, 'loose');
    mkdirSync(dir, { mode: 0o755 });
    saveConfig(defaultConfig(), dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('redactConfig', () => {
  it('never exposes the bearer token', () => {
    const cfg = defaultConfig();
    cfg.auth.token = 'super-secret-value';
    const red = redactConfig(cfg);
    expect(red.auth.token).toBe('<redacted>');
    expect(JSON.stringify(red)).not.toContain('super-secret-value');
  });

  it('leaves an unset token empty', () => {
    expect(redactConfig(defaultConfig()).auth.token).toBe('');
  });
});
