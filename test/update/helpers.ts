import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionDir } from '../../src/paths.js';
import type { UpdateFetch, UpdateRequestInit } from '../../src/update/check.js';
import type { ExecResult, ExecRunner } from '../../src/service/index.js';

/** Temp directories created by a test file, torn down in one `afterAll`. */
export class TempDirs {
  private readonly dirs: string[] = [];

  make(prefix = 'claude-usage-update-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.dirs.push(dir);
    return dir;
  }

  /** A temp `XDG_DATA_HOME`, as the env object every `src/update` function takes. */
  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const home = this.make();
    return { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), ...extra };
  }

  cleanup(): void {
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true });
    this.dirs.length = 0;
  }
}

export interface FakeResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Throw instead of answering — a network error. */
  throws?: string;
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

export interface FakeFetch {
  fetch: UpdateFetch;
  requests: RecordedRequest[];
  /** Bodies read; used to prove an oversized response was rejected before reading. */
  bodyReads: string[];
}

/** A fetch built from a url → response map. Unmapped URLs answer 404. */
export function fakeFetch(routes: Record<string, FakeResponseSpec | (() => FakeResponseSpec)>): FakeFetch {
  const requests: RecordedRequest[] = [];
  const bodyReads: string[] = [];
  const impl = (url: string, init?: UpdateRequestInit): Promise<unknown> => {
    requests.push({ url, headers: { ...(init?.headers ?? {}) } });
    const entry = routes[url];
    const spec: FakeResponseSpec = entry === undefined ? { status: 404, body: '' } : typeof entry === 'function' ? entry() : entry;
    if (spec.throws !== undefined) return Promise.reject(new Error(spec.throws));
    const status = spec.status ?? 200;
    const raw = spec.body ?? '';
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    const headers = new Map<string, string>();
    for (const [k, v] of Object.entries(spec.headers ?? {})) headers.set(k.toLowerCase(), v);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: () => {
        bodyReads.push(url);
        return Promise.resolve(buf.toString('utf8'));
      },
      arrayBuffer: () => {
        bodyReads.push(url);
        return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      },
    });
  };
  return { fetch: impl as unknown as UpdateFetch, requests, bodyReads };
}

export interface FakeExec {
  exec: ExecRunner;
  calls: Array<{ file: string; args: string[] }>;
}

/** An exec runner that dispatches on the command, falling through to a default. */
export function fakeExec(handler: (file: string, args: string[]) => Partial<ExecResult> | void): FakeExec {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: ExecRunner = (file, args) => {
    calls.push({ file, args: [...args] });
    const result = handler(file, [...args]) ?? {};
    return Promise.resolve({ code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  };
  return { exec, calls };
}

/**
 * Build a real `npm pack`-shaped tarball: one `package/` root holding a `package.json`
 * and a `bin/claude-usage` that prints its own version — so the smoke test in `apply()`
 * runs actual node against actually extracted files.
 */
export function makeTarball(dirs: TempDirs, version: string, opts: { prints?: string } = {}): string {
  const staging = dirs.make('claude-usage-pack-');
  const pkg = join(staging, 'package');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@drmuzikbpn/claude-usage', version, bin: { 'claude-usage': 'bin/claude-usage' } }),
  );
  writeFileSync(join(pkg, 'bin', 'claude-usage'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(opts.prints ?? version)});\n`, {
    mode: 0o755,
  });
  const tarball = join(staging, `claude-usage-${version}.tgz`);
  execFileSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  return tarball;
}

/** A minimal installed version directory (no tarball needed). */
export function seedVersion(env: NodeJS.ProcessEnv, version: string): string {
  const dir = versionDir(version, env);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'claude-usage'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  return dir;
}

/** A GitHub `releases/latest` body with both assets present. */
export function releaseJson(version: string, base = 'https://github.example/dl'): string {
  return JSON.stringify({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: `claude-usage-${version}.tgz`, browser_download_url: `${base}/claude-usage-${version}.tgz` },
      { name: 'SHA256SUMS', browser_download_url: `${base}/SHA256SUMS` },
    ],
  });
}
