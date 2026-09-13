#!/usr/bin/env node
/**
 * Print the release version for the current checkout (§20):
 *
 *     MAJOR.MINOR.<git rev-list --count HEAD>+<short sha>
 *
 * MAJOR.MINOR come from `package.json`; the patch is the commit count, which is
 * monotonic on `main`, and the build metadata is the short sha, so every published
 * build names the commit it came from. `npm version --no-git-tag-version <v>` writes
 * this into the tarball's `package.json`, which is what `src/version.ts` reads at
 * runtime — so `claude-usage --version` and the release tag always agree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Default command runner — trimmed stdout, throws on a non-zero exit. */
export function defaultRun(file, args, cwd = REPO_ROOT) {
  return execFileSync(file, args, { cwd, encoding: 'utf8' }).trim();
}

/** `MAJOR.MINOR` of a semver-ish string. Throws when it is not one. */
export function majorMinor(version) {
  const m = /^(\d+)\.(\d+)(?:\.|$)/.exec(String(version ?? '').trim());
  if (m === null) throw new Error(`package.json version "${String(version)}" is not MAJOR.MINOR[.PATCH]`);
  return `${m[1]}.${m[2]}`;
}

/**
 * Compute the version. `run` and `readPackage` are injected by the tests so nothing
 * has to shell out to a real git repository.
 */
export function computeVersion({ run = defaultRun, readPackage = () => JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) } = {}) {
  const base = majorMinor(readPackage().version);
  const count = run('git', ['rev-list', '--count', 'HEAD']);
  if (!/^\d+$/.test(count)) throw new Error(`git rev-list --count HEAD printed "${count}"`);
  const sha = run('git', ['rev-parse', '--short', 'HEAD']);
  if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new Error(`git rev-parse --short HEAD printed "${sha}"`);
  return `${base}.${count}+${sha}`;
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  try {
    process.stdout.write(`${computeVersion()}\n`);
  } catch (err) {
    process.stderr.write(`release-version: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  }
}
