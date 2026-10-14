// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultExec, type ExecRunner } from '../service/index.js';

/**
 * A version directory is a copy of the package *without* `node_modules` (the checkout
 * copy skips it; the release tarball never had it). The daemon is stdlib-only, but the
 * `mcp` and `pair` subcommands lazily import real dependencies, so every
 * version directory needs its production `node_modules` before it becomes `current`.
 *
 * §23.59: those dependencies are installed with `npm ci`, from the lockfile that came
 * with the code — `npm-shrinkwrap.json` in a release tarball (covered by the signed
 * checksum), `package-lock.json` in a checkout. `npm install` would re-resolve the `^`
 * ranges on the day and could pull in a version nobody tested; with no lockfile there is
 * nothing to install *from*, so that is an error rather than a fallback.
 */
export const RUNTIME_DEP_SENTINEL = join('node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
export const NPM_CI_ARGS = ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'] as const;
/** Either pins the whole tree; a release carries the first, a checkout the second. */
export const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'] as const;

export class RuntimeDepsError extends Error {
  override readonly name = 'RuntimeDepsError';
}

/** Install production deps into `dir` when the sentinel is missing. Returns true when npm ran. */
export async function ensureRuntimeDeps(dir: string, exec: ExecRunner = defaultExec): Promise<boolean> {
  if (!declaresDependencies(dir)) return false;
  if (existsSync(join(dir, RUNTIME_DEP_SENTINEL))) return false;
  if (!LOCKFILES.some((name) => existsSync(join(dir, name)))) {
    throw new RuntimeDepsError(
      `${dir} has no ${LOCKFILES.join(' or ')} — refusing to resolve its dependencies unpinned`,
    );
  }
  const result = await exec('npm', ['--prefix', dir, ...NPM_CI_ARGS]);
  if (result.code !== 0) {
    throw new RuntimeDepsError(
      `npm ci in ${dir} failed (exit ${String(result.code)}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return true;
}

/** A package with no `dependencies` (test fixtures, stripped builds) has nothing to install. */
function declaresDependencies(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return Object.keys(pkg.dependencies ?? {}).length > 0;
  } catch {
    return false;
  }
}
