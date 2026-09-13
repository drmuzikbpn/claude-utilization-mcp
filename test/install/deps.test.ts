import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NPM_INSTALL_ARGS, RUNTIME_DEP_SENTINEL, RuntimeDepsError, ensureRuntimeDeps } from '../../src/install/deps.js';
import { fakeExec } from './helpers.js';

function withDeps(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cu-deps-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', dependencies: { '@modelcontextprotocol/sdk': '^1' } }));
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

  it('runs npm install --omit=dev against the version dir when the SDK is missing', async () => {
    const dir = withDeps();
    const exec = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(ensureRuntimeDeps(dir, exec.runner)).resolves.toBe(true);
    expect(exec.calls).toEqual([{ file: 'npm', args: ['--prefix', dir, ...NPM_INSTALL_ARGS] }]);
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
