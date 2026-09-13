import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PROJECTS = fileURLToPath(
  new URL('../fixtures/spend/projects', import.meta.url),
);

export const SESSION_A = '11111111-1111-4111-8111-111111111111';
export const SESSION_B = '22222222-2222-4222-8222-222222222222';
export const PROJECT_A = '-home-dev-alpha';
export const PROJECT_B = '-home-dev-beta';

/** Transcript paths, relative to the projects dir. */
export const MAIN_A = `${PROJECT_A}/${SESSION_A}.jsonl`;
export const SUB_A = `${PROJECT_A}/${SESSION_A}/subagents/agent-fixtureagent01.jsonl`;
export const MAIN_B = `${PROJECT_B}/${SESSION_B}.jsonl`;

const roots: string[] = [];

/** A temp dir removed by `cleanupTempDirs()`; never touches the real `~/.claude`. */
export async function makeTempDir(prefix = 'claude-usage-spend-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A writable copy of the checked-in fixture tree. */
export async function copyFixtures(): Promise<string> {
  const dir = await makeTempDir();
  const projects = join(dir, 'projects');
  await cp(FIXTURE_PROJECTS, projects, { recursive: true });
  return projects;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}
