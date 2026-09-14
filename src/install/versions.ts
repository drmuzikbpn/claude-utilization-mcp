import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentLink, versionDir, versionsDir } from '../paths.js';

/**
 * The §20 versions layout.
 *
 * `install` copies the running package into
 * `<XDG_DATA_HOME>/claude-usage/versions/<version>/` and points `current` at it, so
 * that after install the install method (npm, tarball, git checkout) no longer
 * matters and the auto-updater (W8) has a layout to swap.
 */

/** Never copied into a version directory. */
export const COPY_EXCLUDES = ['node_modules', '.git', '.claude', 'src', 'test', 'docs', 'skill-observations', 'coverage'];

/**
 * Walk up from `startDir` to the directory holding the `package.json` that declares
 * our `claude-usage` bin — the installed package root.
 */
export function resolvePackageRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { bin?: Record<string, string> };
        if (parsed.bin?.['claude-usage'] !== undefined) return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the claude-usage package root (no package.json with a `claude-usage` bin)');
}

/** Atomically repoint a symlink: create a temp link beside it, then `rename(2)`. */
export function repointSymlink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true });
  // A real directory sitting where the symlink belongs cannot be renamed over.
  try {
    if (!lstatSync(link).isSymbolicLink()) rmSync(link, { recursive: true, force: true });
  } catch {
    // nothing there yet
  }
  const tmp = `${link}.tmp.${String(process.pid)}`;
  rmSync(tmp, { recursive: true, force: true });
  symlinkSync(target, tmp, 'dir');
  renameSync(tmp, link);
}

export interface InstallVersionOptions {
  version: string;
  /** The package directory to copy — defaults to the running package root. */
  sourceDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallVersionResult {
  versionDir: string;
  currentLink: string;
  /** False when this version was already installed, or when we are already running from it. */
  copied: boolean;
}

/** Copy the running package into `versions/<version>/` and repoint `current` (§20). */
export function installVersion(opts: InstallVersionOptions): InstallVersionResult {
  const env = opts.env ?? process.env;
  const source = resolve(opts.sourceDir ?? resolvePackageRoot());
  const dest = versionDir(opts.version, env);
  const link = currentLink(env);

  // Only skip when the destination IS the source. A same-version directory must still be
  // refreshed: reinstalling from a checkout (the documented pre-release install, and how
  // both machines were set up) otherwise silently keeps the old build — the Studio ran
  // stale code through three "successful" reinstalls because of this.
  const alreadyThere = resolve(dest) === source;
  if (!alreadyThere) {
    mkdirSync(versionsDir(env), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(source, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => !COPY_EXCLUDES.includes(src.slice(source.length + 1).split('/')[0] ?? ''),
    });
  }
  repointSymlink(link, dest);
  return { versionDir: dest, currentLink: link, copied: !alreadyThere };
}
