import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { APP, currentBin, resolveHome } from '../paths.js';

/**
 * Put `claude-usage` on the PATH (§23.51): a symlink in the user's bin directory to the
 * `current` binary, so it follows every update and rollback without being rewritten.
 *
 * Never clobbers: anything already at the link path that is not our link (an npm global
 * shim, a user's own script) is left alone and reported.
 */

/** `$XDG_BIN_HOME`, falling back to `~/.local/bin` — the directory the link goes in. */
export function userBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['XDG_BIN_HOME'];
  return typeof v === 'string' && v.length > 0 ? v : join(resolveHome(env), '.local', 'bin');
}

export function pathLinkFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(userBinDir(env), APP);
}

export type PathLinkOutcome = 'linked' | 'already' | 'other';

export interface PathLinkResult {
  outcome: PathLinkOutcome;
  link: string;
  /** Whether the link's directory is on `env.PATH`. */
  onPath: boolean;
}

/** Is `dir` one of the entries of `env.PATH`? */
export function isOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = resolve(dir);
  return (env['PATH'] ?? '').split(delimiter).some((entry) => entry.length > 0 && resolve(entry) === target);
}

/** Our link: a symlink at `link` pointing at `currentBin`. */
function isOurLink(link: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(userBinDir(env), readlinkSync(link)) === resolve(currentBin(env));
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function linkOnPath(env: NodeJS.ProcessEnv = process.env): PathLinkResult {
  const link = pathLinkFile(env);
  const onPath = isOnPath(userBinDir(env), env);
  if (isOurLink(link, env)) return { outcome: 'already', link, onPath };
  if (exists(link)) return { outcome: 'other', link, onPath };
  mkdirSync(userBinDir(env), { recursive: true });
  symlinkSync(currentBin(env), link);
  return { outcome: 'linked', link, onPath };
}

/** Remove the link only if it is ours. Returns whether anything was removed. */
export function unlinkFromPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const link = pathLinkFile(env);
  if (!isOurLink(link, env)) return false;
  rmSync(link, { force: true });
  return true;
}

/** The install line describing the result, plus a note when something needs the user. */
export function describePathLink(r: PathLinkResult, env: NodeJS.ProcessEnv = process.env): { line: string; note: string | null } {
  if (r.outcome === 'other') {
    return {
      line: `path:    left ${r.link} alone (not ours)\n`,
      note: `${r.link} already exists and is not a link to this install — run \`${currentBin(env)}\` or remove that file and re-run install`,
    };
  }
  const line = `path:    ${r.outcome === 'linked' ? 'linked' : 'already linked'} ${r.link}\n`;
  if (r.onPath) return { line, note: null };
  return {
    line,
    note: `${userBinDir(env)} is not on your PATH — add \`export PATH="${userBinDir(env)}:$PATH"\` to your shell profile, then open a new terminal`,
  };
}
