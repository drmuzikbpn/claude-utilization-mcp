import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** Version string from the packaged `package.json`. Never throws. */
export function getVersion(): string {
  if (cached !== undefined) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts -> ../package.json ; dist/version.js -> ../package.json
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(here, rel), 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        const v = (parsed as { version?: unknown }).version;
        if (typeof v === 'string' && v.length > 0) {
          cached = v;
          return cached;
        }
      }
    } catch {
      // try the next candidate
    }
  }
  cached = '0.0.0';
  return cached;
}
