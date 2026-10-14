// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Install a verified tarball into the versions layout and repoint `current` (§20).
 *
 * Order matters and is the whole point of this file: extract to a scratch directory,
 * prove the extracted build runs (`--version` must print the version we think we
 * installed), *then* repoint the symlink atomically. A build that cannot start never
 * becomes `current`, so a bad release costs a failed check, not a dead daemon.
 *
 * Extraction shells out to the system `tar` — the daemon has no runtime dependencies
 * (CLAUDE.md invariant), and both macOS bsdtar and GNU tar accept these flags.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { currentBin, currentLink, versionDir, versionsDir } from '../paths.js';
import { repointSymlink } from '../install/versions.js';
import { defaultExec, type ExecRunner } from '../service/index.js';
import { ensureRuntimeDeps } from '../install/deps.js';
import { compareVersions, parseVersion } from './version.js';
import { UpdateError } from './download.js';
import { sortVersionsDesc } from './version.js';

/** How many superseded versions survive a successful apply (§20). */
export const KEEP_PREVIOUS = 2;
export const SMOKE_TIMEOUT_MS = 30_000;

/** Directory names under `versions/`, newest first. */
export function listVersions(env: NodeJS.ProcessEnv = process.env): string[] {
  let entries: string[];
  try {
    entries = readdirSync(versionsDir(env), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return sortVersionsDesc(entries);
}

/** The version `current` resolves to, or `null` when the link is absent or dangling. */
export function currentVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const resolved = realpathSync(currentLink(env));
    const root = realpathSync(versionsDir(env));
    if (!resolved.startsWith(`${root}/`)) return null;
    return resolved.slice(root.length + 1).split('/')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * `true` when this process is running out of the `current` symlink — i.e. it was put
 * there by `install`. When it is not, the updater has no layout to swap and disables
 * itself (§20 "Off switch").
 */
export function runningUnderCurrent(packageRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return realpathSync(packageRoot) === realpathSync(currentLink(env));
  } catch {
    return false;
  }
}

/**
 * `tar` by absolute path where there is one: the daemon runs this unattended, and a `tar`
 * earlier on its `PATH` would see every update first.
 */
export function tarBin(exists: (path: string) => boolean = existsSync): string {
  return ['/usr/bin/tar', '/bin/tar'].find((p) => exists(p)) ?? 'tar';
}

/**
 * Is every member of an `npm pack` tarball a plain relative path under `package/`
 * (§23.59)? Both tars already refuse `..` and absolute names by default; this does not
 * rely on it, and it also refuses anything outside the one root `--strip-components=1`
 * expects.
 */
export function unsafeMembers(listing: string): string[] {
  const bad: string[] = [];
  for (const raw of listing.split('\n')) {
    const name = raw.replace(/\r$/, '');
    if (name.length === 0) continue;
    const parts = name.split('/');
    const ok =
      !name.startsWith('/') &&
      !name.includes('\\') &&
      parts[0] === 'package' &&
      !parts.some((p) => p === '..' || p === '.') &&
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
      !/[\u0000-\u001f]/.test(name);
    if (!ok) bad.push(name);
  }
  return bad;
}

/** Every symlink under `dir`, as paths relative to it. `npm pack` never produces one. */
export function symlinksUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) out.push(child);
      else if (entry.isDirectory()) walk(child);
    }
  };
  walk('');
  return out;
}

/**
 * `tar -xzf <tarball> -C <dir> --strip-components=1` — the tarball's `package/` root is
 * stripped. The member list is checked first and the result afterwards (§23.59), and
 * ownership is never taken from the archive.
 */
export async function extractTarball(tarballPath: string, destDir: string, exec: ExecRunner = defaultExec): Promise<void> {
  const tar = tarBin();
  const listed = await exec(tar, ['-tzf', tarballPath]);
  if (listed.code !== 0) {
    throw new UpdateError('extract_failed', `tar could not list the archive (exit ${String(listed.code)}): ${listed.stderr.trim()}`);
  }
  const bad = unsafeMembers(listed.stdout);
  if (bad.length > 0) {
    throw new UpdateError('unsafe_archive', `the archive has members outside package/: ${bad.slice(0, 3).map((b) => JSON.stringify(b)).join(', ')}`);
  }
  mkdirSync(destDir, { recursive: true });
  const result = await exec(tar, ['-xzf', tarballPath, '-C', destDir, '--strip-components=1', '--no-same-owner']);
  if (result.code !== 0) {
    throw new UpdateError('extract_failed', `tar failed (exit ${String(result.code)}): ${result.stderr.trim()}`);
  }
  const links = symlinksUnder(destDir);
  if (links.length > 0) {
    throw new UpdateError('unsafe_archive', `the archive contains symbolic links: ${links.slice(0, 3).join(', ')}`);
  }
}

export interface SmokeOptions {
  exec?: ExecRunner;
  /** Absolute node binary — the unit files use one for the same reason (§23.9). */
  nodePath?: string;
}

/**
 * Run `<node> <dir>/bin/claude-usage --version` and require it to print `version`.
 * Anything else — non-zero exit, a different version, no output — fails the apply.
 */
export async function smokeTest(dir: string, version: string, opts: SmokeOptions = {}): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  const node = opts.nodePath ?? process.execPath;
  const bin = join(dir, 'bin', 'claude-usage');
  const result = await exec(node, [bin, '--version']);
  const printed = result.stdout.trim();
  if (result.code !== 0) {
    throw new UpdateError('smoke_failed', `${bin} --version exited ${String(result.code)}: ${result.stderr.trim()}`);
  }
  // Build metadata is ignored (semver §10): CI stamps package.json with the core
  // `MAJOR.MINOR.PATCH` while the release tag carries `+<sha>`, so `--version` prints the
  // core. Require the version cores to match; the `+build` suffix legitimately differs.
  if (compareVersions(printed, version) !== 0) {
    throw new UpdateError('smoke_failed', `${bin} --version printed "${printed}", expected "${version}" (core mismatch)`);
  }
}

/** Delete every version except `current` and the newest `keep` superseded ones. */
export function pruneVersions(env: NodeJS.ProcessEnv = process.env, keep: number = KEEP_PREVIOUS): string[] {
  const current = currentVersion(env);
  const ordered = listVersions(env);
  const survivors = new Set<string>();
  if (current !== null) survivors.add(current);
  for (const v of ordered) {
    if (survivors.size >= keep + 1) break;
    survivors.add(v);
  }
  const removed: string[] = [];
  for (const v of ordered) {
    if (survivors.has(v)) continue;
    rmSync(versionDir(v, env), { recursive: true, force: true });
    removed.push(v);
  }
  return removed;
}

export interface ApplyOptions {
  version: string;
  tarballPath: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecRunner;
  nodePath?: string;
  keep?: number;
  /** Leave `current` alone (used by `update --check`-style dry runs and tests). */
  repoint?: boolean;
}

export interface ApplyResult {
  versionDir: string;
  previousVersion: string | null;
  pruned: string[];
}

/**
 * Extract → smoke-test → repoint `current` → prune. Throws `UpdateError` before the
 * repoint for every failure mode, leaving the running version untouched.
 */
export async function apply(opts: ApplyOptions): Promise<ApplyResult> {
  // The version becomes a directory name: nothing but `MAJOR.MINOR.PATCH[+build]` gets that far.
  if (parseVersion(opts.version) === null || opts.version.includes('/')) {
    throw new UpdateError('bad_version', `refusing to install a release called ${JSON.stringify(opts.version)}`);
  }
  const env = opts.env ?? process.env;
  const previousVersion = currentVersion(env);
  const target = versionDir(opts.version, env);
  const staging = `${target}.incoming.${String(process.pid)}`;

  mkdirSync(versionsDir(env), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  try {
    await extractTarball(opts.tarballPath, staging, opts.exec ?? defaultExec);
    // The tarball has no node_modules; `mcp`/`pair` need them (§20 smoke test runs after).
    await ensureRuntimeDeps(staging, opts.exec ?? defaultExec);
    const smoke: SmokeOptions = {};
    if (opts.exec !== undefined) smoke.exec = opts.exec;
    if (opts.nodePath !== undefined) smoke.nodePath = opts.nodePath;
    await smokeTest(staging, opts.version, smoke);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // The smoke test passed, so this build is safe to become `current`.
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  if (opts.repoint !== false) repointSymlink(currentLink(env), target);
  const pruned = opts.repoint === false ? [] : pruneVersions(env, opts.keep ?? KEEP_PREVIOUS);
  return { versionDir: target, previousVersion, pruned };
}

export interface RollbackResult {
  from: string | null;
  to: string;
  versionDir: string;
}

/** Repoint `current` at the newest version below the one it points at now (§20). */
export function rollback(env: NodeJS.ProcessEnv = process.env): RollbackResult {
  const versions = listVersions(env);
  const current = currentVersion(env);
  const candidates = current === null ? versions : versions.slice(versions.indexOf(current) + 1);
  const target = candidates.find((v) => {
    try {
      return statSync(join(versionDir(v, env), 'bin', 'claude-usage')).isFile();
    } catch {
      return false;
    }
  });
  if (target === undefined) {
    throw new UpdateError('no_previous_version', 'there is no previous version installed to roll back to');
  }
  const dir = versionDir(target, env);
  repointSymlink(currentLink(env), dir);
  return { from: current, to: target, versionDir: dir };
}

/** `<data>/claude-usage/current/bin/claude-usage` — what the unit files exec. */
export function currentBinPath(env: NodeJS.ProcessEnv = process.env): string {
  return currentBin(env);
}

/** `true` when the versions layout exists at all. */
export function layoutExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(currentLink(env));
}
