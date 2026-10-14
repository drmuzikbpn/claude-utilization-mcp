// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/** §23.59: the release side of signing — the scripts CI runs, and the workflow that runs them. */

import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RELEASE_PUBLIC_KEY_PLACEHOLDER, TRUSTED_RELEASE_KEYS } from '../../src/update/trusted-keys.js';
import { verify, verifySignature } from '../../src/update/verify.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SIGN = join(ROOT, 'scripts', 'sign-release.mjs');
const VERIFY = join(ROOT, 'scripts', 'verify-release.mjs');

/** Imported through a URL so `tsc` does not try to typecheck the .mjs helpers. */
const verifyMod = (await import(new URL('../../scripts/verify-release.mjs', import.meta.url).href)) as {
  readTrustedKeys: (source: string) => Array<{ id: string; publicKey: string }>;
  main: (argv: string[], io: { out: (t: string) => void; err: (t: string) => void }, keysFile?: string) => number;
  PLACEHOLDER: string;
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cu-release-sign-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh key pair, in memory: the private half as the PEM CI keeps in its secret. */
function keyPair(type: 'ed25519' | 'rsa' = 'ed25519'): { pem: string } {
  const pair = type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519');
  return { pem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

function node(script: string, args: string[], env: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env } });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

/** A release directory as the build job leaves it: tarball + SHA256SUMS. */
function releaseDir(): { dir: string; sums: string; tarball: string } {
  const dir = tempDir();
  const tarball = join(dir, 'claude-usage-1.2.3.tgz');
  writeFileSync(tarball, 'pretend tarball bytes');
  const sums = join(dir, 'SHA256SUMS');
  writeFileSync(sums, `${createHash('sha256').update(readFileSync(tarball)).digest('hex')}  claude-usage-1.2.3.tgz\n`);
  return { dir, sums, tarball };
}

function keysFile(entries: string): string {
  const file = join(tempDir(), 'trusted-keys.ts');
  writeFileSync(file, `export const RELEASE_PUBLIC_KEY_PLACEHOLDER = 'RELEASE_PUBLIC_KEY_PLACEHOLDER';\nexport const TRUSTED_RELEASE_KEYS: readonly TrustedKey[] = [\n${entries}\n];\n`);
  return file;
}

describe('scripts/sign-release.mjs', () => {
  it('signs SHA256SUMS so that the updater’s own verifier accepts it under the printed public key', async () => {
    const { pem } = keyPair();
    const { sums, tarball } = releaseDir();
    const pub = node(SIGN, ['--public-key'], { RELEASE_SIGNING_KEY: pem });
    expect(pub.code).toBe(0);
    const publicKey = pub.out.trim();
    expect(publicKey).toMatch(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/);

    const signed = node(SIGN, [sums], { RELEASE_SIGNING_KEY: pem });
    expect(signed.code).toBe(0);
    const trustedKeys = [{ id: 'ci', publicKey }];
    expect(verifySignature({ shasumsPath: sums, signaturePath: `${sums}.sig`, trustedKeys }).keyId).toBe('ci');
    await expect(verify({ tarballPath: tarball, shasumsPath: sums, signaturePath: `${sums}.sig`, trustedKeys })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the key from RELEASE_SIGNING_KEY only, and never prints any of it', () => {
    const { pem } = keyPair();
    const { sums } = releaseDir();
    const body = pem.split('\n').filter((l) => !l.startsWith('-----') && l.length > 0).join('');

    const missing = node(SIGN, [sums]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('RELEASE_SIGNING_KEY is not set');

    // A key passed as an argument is not a key: it is refused as usage, not read.
    const asArg = node(SIGN, [sums, pem]);
    expect(asArg.code).toBe(2);
    expect(asArg.out + asArg.err).not.toContain(body.slice(0, 20));

    const broken = node(SIGN, [sums], { RELEASE_SIGNING_KEY: pem.replace(body.slice(10, 30), 'x'.repeat(20)) });
    expect(broken.code).toBe(1);
    expect(broken.err).toContain('not a PEM private key');
    expect(broken.out + broken.err).not.toContain(body.slice(0, 10));

    const ok = node(SIGN, [sums], { RELEASE_SIGNING_KEY: pem });
    expect(ok.out + ok.err).not.toContain(body.slice(0, 10));
    expect(readFileSync(`${sums}.sig`, 'utf8')).not.toContain(body.slice(0, 10));
  });

  it('refuses a key that is not Ed25519, and an empty file', () => {
    const { sums, dir } = releaseDir();
    const rsa = node(SIGN, [sums], { RELEASE_SIGNING_KEY: keyPair('rsa').pem });
    expect(rsa.code).toBe(1);
    expect(rsa.err).toContain('must be an Ed25519 key');
    const empty = join(dir, 'EMPTY');
    writeFileSync(empty, '');
    expect(node(SIGN, [empty], { RELEASE_SIGNING_KEY: keyPair().pem }).code).toBe(1);
  });
});

describe('scripts/verify-release.mjs', () => {
  function run(argv: string[], file: string): { code: number; out: string; err: string } {
    let out = '';
    let err = '';
    const code = verifyMod.main(argv, { out: (t) => (out += t), err: (t) => (err += t) }, file);
    return { code, out, err };
  }

  function signedWith(pem: string): { sums: string; tarball: string; publicKey: string } {
    const r = releaseDir();
    expect(node(SIGN, [r.sums], { RELEASE_SIGNING_KEY: pem }).code).toBe(0);
    return { ...r, publicKey: node(SIGN, ['--public-key'], { RELEASE_SIGNING_KEY: pem }).out.trim() };
  }

  it('passes a release signed by a trusted key whose files all match', () => {
    const { pem } = keyPair();
    const r = signedWith(pem);
    const res = run([r.sums], keysFile(`  { id: 'release-test', publicKey: '${r.publicKey}' },`));
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    expect(res.out).toContain('signed by "release-test"');
  });

  it('fails a release signed by a key installed daemons do not trust', () => {
    const r = signedWith(keyPair().pem);
    const other = node(SIGN, ['--public-key'], { RELEASE_SIGNING_KEY: keyPair().pem }).out.trim();
    const res = run([r.sums], keysFile(`  { id: 'someone-else', publicKey: '${other}' },`));
    expect(res.code).toBe(1);
    expect(res.err).toContain('would refuse this release');
  });

  it('fails when the tarball no longer matches the signed checksum', () => {
    const r = signedWith(keyPair().pem);
    writeFileSync(r.tarball, 'different bytes');
    const res = run([r.sums], keysFile(`  { id: 'k', publicKey: '${r.publicKey}' },`));
    expect(res.code).toBe(1);
    expect(res.err).toContain('does not match');
  });

  it('fails when the signature is missing', () => {
    const r = releaseDir();
    expect(run([r.sums], keysFile(`  { id: 'k', publicKey: 'x' },`)).code).toBe(1);
  });

  it('--no-placeholder fails while the placeholder is listed, and passes with real keys only', () => {
    const placeholder = run(['--no-placeholder'], keysFile("  { id: 'release-2026-10', publicKey: RELEASE_PUBLIC_KEY_PLACEHOLDER },"));
    expect(placeholder.code).toBe(1);
    expect(placeholder.err).toContain('still contains RELEASE_PUBLIC_KEY_PLACEHOLDER');
    const pub = node(SIGN, ['--public-key'], { RELEASE_SIGNING_KEY: keyPair().pem }).out.trim();
    expect(run(['--no-placeholder'], keysFile(`  { id: 'release-2026-10', publicKey: '${pub}' },`)).code).toBe(0);
    expect(run(['--no-placeholder'], keysFile("  { id: 'junk', publicKey: 'AAAA' },")).code).toBe(1);
    expect(run(['--no-placeholder'], keysFile('')).code).toBe(1);
  });

  it('reads the shipped trusted-keys.ts exactly as the TypeScript module exports it', () => {
    const parsed = verifyMod.readTrustedKeys(readFileSync(join(ROOT, 'src', 'update', 'trusted-keys.ts'), 'utf8'));
    expect(parsed).toEqual(TRUSTED_RELEASE_KEYS.map((k) => ({ id: k.id, publicKey: k.publicKey })));
    expect(verifyMod.PLACEHOLDER).toBe(RELEASE_PUBLIC_KEY_PLACEHOLDER);
  });

  it('as a CLI, --no-placeholder reports on the real file', () => {
    const res = node(VERIFY, ['--no-placeholder']);
    const hasPlaceholder = TRUSTED_RELEASE_KEYS.some((k) => k.publicKey === RELEASE_PUBLIC_KEY_PLACEHOLDER);
    expect(res.code).toBe(hasPlaceholder ? 1 : 0);
  });
});

describe('.github/workflows (§23.59)', () => {
  const release = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  /** The text of one top-level job, from its key to the next job's. */
  function job(name: string): string {
    const start = release.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = release.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  it.each([
    ['release.yml', release],
    ['ci.yml', ci],
  ])('%s pins every action to a full commit SHA, with the version in a comment', (_name, text) => {
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/^\s+# v\d+\.\d+\.\d+$/);
    }
  });

  it('publishes with the first-party gh CLI, never npm, and asks for no OIDC token', () => {
    expect(release).not.toMatch(/softprops/);
    expect(release).not.toMatch(/npm publish/);
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/);
    expect(release).not.toMatch(/id-token/);
    expect(release).toMatch(/gh release create/);
  });

  it('the build job can read and nothing more, and holds no secret', () => {
    const build = job('build');
    expect(build).toMatch(/permissions:\n\s+contents: read\n/);
    expect(build).not.toMatch(/secrets\./);
    expect(build).not.toMatch(/environment:/);
    expect(build).toMatch(/npm shrinkwrap/);
    expect(build).toMatch(/npm audit --omit=dev/);
  });

  it('the publish job needs build, runs on main only, in the release environment, and signs then verifies', () => {
    const publish = job('publish');
    expect(publish).toMatch(/needs: \[guard, build\]/);
    expect(publish).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(publish).toMatch(/environment: release\n/);
    expect(publish).toMatch(/permissions:\n\s+contents: write\n/);
    expect(publish).not.toMatch(/npm (ci|install|run|test)/);
    const order = ['verify-release.mjs --no-placeholder', 'sign-release.mjs release/SHA256SUMS', 'verify-release.mjs release/SHA256SUMS', 'gh release create'].map((s) => publish.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(publish).toMatch(/RELEASE_SIGNING_KEY: \$\{\{ secrets\.RELEASE_SIGNING_KEY \}\}/);
    for (const asset of ['claude-usage-$VERSION.tgz', 'release/SHA256SUMS ', 'release/SHA256SUMS.sig']) expect(publish).toContain(asset);
  });

  it('the token defaults to no permissions at all', () => {
    expect(release).toMatch(/^permissions: \{\}$/m);
    expect(ci).toMatch(/^permissions:\n\s+contents: read$/m);
  });

  it('the package can never be published to npm by accident', () => {
    expect((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { private?: unknown }).private).toBe(true);
  });
});
