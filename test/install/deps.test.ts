// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKFILES, NPM_CI_ARGS, RUNTIME_DEP_SENTINEL, RuntimeDepsError, ensureRuntimeDeps } from '../../src/install/deps.js';
import { fakeExec } from './helpers.js';

function withDeps(lockfile: string | null = 'npm-shrinkwrap.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'cu-deps-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', dependencies: { '@modelcontextprotocol/sdk': '^1' } }));
  if (lockfile !== null) writeFileSync(join(dir, lockfile), '{"lockfileVersion":3}');
  return dir;
}

describe('ensureRuntimeDeps', () => {
  it('does nothing for a package that declares no dependencies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-deps-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    const exec = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(ensureRuntimeDeps(dir, exec.runner)).resolves.toBe(false);
    expect(exec.calls).toEqual([]);
  });

  it.each(LOCKFILES)('runs npm ci --omit=dev --ignore-scripts from %s when the SDK is missing (§23.59)', async (lockfile) => {
    const dir = withDeps(lockfile);
    const exec = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(ensureRuntimeDeps(dir, exec.runner)).resolves.toBe(true);
    expect(exec.calls).toEqual([{ file: 'npm', args: ['--prefix', dir, ...NPM_CI_ARGS] }]);
    expect(NPM_CI_ARGS[0]).toBe('ci');
    expect(NPM_CI_ARGS).toContain('--omit=dev');
    expect(NPM_CI_ARGS).toContain('--ignore-scripts');
    expect(NPM_CI_ARGS).not.toContain('install');
  });

  it('refuses to resolve dependencies at all when there is no lockfile (§23.59)', async () => {
    const dir = withDeps(null);
    const exec = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(ensureRuntimeDeps(dir, exec.runner)).rejects.toThrow(/no npm-shrinkwrap\.json or package-lock\.json/);
    expect(exec.calls).toEqual([]);
  });

  it('is a no-op when the sentinel package is already present', async () => {
    const dir = withDeps();
    mkdirSync(join(dir, RUNTIME_DEP_SENTINEL, '..'), { recursive: true });
    writeFileSync(join(dir, RUNTIME_DEP_SENTINEL), '{}');
    const exec = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(ensureRuntimeDeps(dir, exec.runner)).resolves.toBe(false);
    expect(exec.calls).toEqual([]);
  });

  it('throws RuntimeDepsError with npm output when the install fails', async () => {
    const dir = withDeps();
    const exec = fakeExec(() => ({ code: 1, stdout: '', stderr: 'ERESOLVE boom' }));
    await expect(ensureRuntimeDeps(dir, exec.runner)).rejects.toBeInstanceOf(RuntimeDepsError);
    await expect(ensureRuntimeDeps(dir, exec.runner)).rejects.toThrow(/ERESOLVE boom/);
  });
});
