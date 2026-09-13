import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/release-version.mjs', import.meta.url);

/** Imported through a URL so `tsc` does not try to typecheck the .mjs helper. */
const mod = (await import(SCRIPT.href)) as {
  computeVersion: (opts?: { run?: (f: string, a: string[]) => string; readPackage?: () => { version: string } }) => string;
  majorMinor: (v: string) => string;
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-relver-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/release-version.mjs (§20)', () => {
  it('prints MAJOR.MINOR.<commit count>+<short sha>', () => {
    const calls: string[][] = [];
    const version = mod.computeVersion({
      run: (file, args) => {
        calls.push([file, ...args]);
        return args[1] === '--count' ? '417' : '3f9c2ab';
      },
      readPackage: () => ({ version: '0.1.0' }),
    });
    expect(version).toBe('0.1.417+3f9c2ab');
    expect(calls).toEqual([
      ['git', 'rev-list', '--count', 'HEAD'],
      ['git', 'rev-parse', '--short', 'HEAD'],
    ]);
  });

  it('takes MAJOR.MINOR from package.json and ignores its patch', () => {
    const version = mod.computeVersion({
      run: (_f, args) => (args[1] === '--count' ? '9' : 'abcdef1'),
      readPackage: () => ({ version: '2.7.999' }),
    });
    expect(version).toBe('2.7.9+abcdef1');
    expect(mod.majorMinor('12.34.56')).toBe('12.34');
  });

  it('refuses a package.json version that is not MAJOR.MINOR', () => {
    expect(() => mod.computeVersion({ run: () => '1', readPackage: () => ({ version: 'nope' }) })).toThrow(/MAJOR\.MINOR/);
  });

  it('refuses git output it did not expect', () => {
    expect(() =>
      mod.computeVersion({ run: (_f, args) => (args[1] === '--count' ? 'fatal: not a repo' : 'x'), readPackage: () => ({ version: '0.1.0' }) }),
    ).toThrow(/rev-list/);
    expect(() =>
      mod.computeVersion({ run: (_f, args) => (args[1] === '--count' ? '3' : 'not a sha!') , readPackage: () => ({ version: '0.1.0' }) }),
    ).toThrow(/rev-parse/);
  });

  it('runs end to end against a fake git on PATH', () => {
    const shim = tempDir();
    const git = join(shim, 'git');
    writeFileSync(
      git,
      ['#!/bin/sh', 'case "$2" in', '  --count) echo 1234 ;;', '  --short) echo deadbee ;;', '  *) exit 1 ;;', 'esac', ''].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(git, 0o755);
    const out = execFileSync(process.execPath, [SCRIPT.pathname], {
      encoding: 'utf8',
      env: { ...process.env, PATH: shim },
    });
    // The real package.json supplies MAJOR.MINOR, so assert the shape, not the numbers.
    expect(out.trim()).toMatch(/^\d+\.\d+\.1234\+deadbee$/);
  });
});
