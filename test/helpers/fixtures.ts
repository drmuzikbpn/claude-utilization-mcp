import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = join(here, '..', 'fixtures');

/**
 * The captured upstream payload — the only source for the shape of
 * `GET /api/oauth/usage`. Tests never call the real endpoint.
 */
export function liveLimitsFixture(): Record<string, unknown> {
  const text = readFileSync(join(FIXTURES_DIR, 'limits', 'live-2026-09-13.json'), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}
