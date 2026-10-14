#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * CI's self-check on a release it is about to publish (§23.59).
 *
 *     node scripts/verify-release.mjs release/SHA256SUMS
 *
 * succeeds only if `release/SHA256SUMS.sig` is a valid signature over `release/SHA256SUMS`
 * by one of the keys in `src/update/trusted-keys.ts` — the keys installed daemons will use
 * — and every file `SHA256SUMS` lists is present beside it with that digest. A release
 * signed with a key nobody trusts would publish fine and then be refused by every updater;
 * this is what catches that before the tag exists.
 *
 *     node scripts/verify-release.mjs --no-placeholder
 *
 * fails while `trusted-keys.ts` still holds the placeholder entry. The release workflow
 * runs it first, so a build that can verify nothing is never shipped.
 *
 * Stdlib only, and it reads the TypeScript source as text, so the publish job needs no
 * `npm ci` and no build.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TRUSTED_KEYS_FILE = join(REPO_ROOT, 'src', 'update', 'trusted-keys.ts');
export const PLACEHOLDER = 'RELEASE_PUBLIC_KEY_PLACEHOLDER';

/**
 * The `{ id, publicKey }` entries of `TRUSTED_RELEASE_KEYS`, read from the source text. An
 * entry whose key is the placeholder constant comes back with `publicKey: PLACEHOLDER`.
 */
export function readTrustedKeys(source) {
  const start = source.indexOf('TRUSTED_RELEASE_KEYS');
  const open = start === -1 ? -1 : source.indexOf('[', source.indexOf('=', start));
  const close = open === -1 ? -1 : source.indexOf('];', open);
  if (open === -1 || close === -1) throw new Error('could not find the TRUSTED_RELEASE_KEYS list');
  const body = source.slice(open + 1, close);
  const keys = [];
  const entry = /\{\s*id:\s*'([^']*)'\s*,\s*publicKey:\s*(?:'([^']*)'|([A-Z_]+))\s*,?\s*\}/g;
  for (let m = entry.exec(body); m !== null; m = entry.exec(body)) {
    keys.push({ id: m[1], publicKey: m[2] ?? (m[3] === PLACEHOLDER ? PLACEHOLDER : '') });
  }
  return keys;
}

export function usableKey(entry) {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(entry.publicKey)) return null;
    const key = createPublicKey({ key: Buffer.from(entry.publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** Throws with a one-line reason; returns the id of the key that verified the file. */
export function verifyRelease(sumsPath, keys, sigPath = `${sumsPath}.sig`) {
  const sums = readFileSync(sumsPath);
  const sigText = readFileSync(sigPath, 'utf8').trim();
  const signature = Buffer.from(sigText, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sigText) || signature.byteLength !== 64) throw new Error(`${sigPath} is not a base64 Ed25519 signature`);

  let keyId = null;
  for (const entry of keys) {
    const key = usableKey(entry);
    if (key !== null && verify(null, sums, key, signature)) {
      keyId = entry.id;
      break;
    }
  }
  if (keyId === null) throw new Error(`${sumsPath} is not signed by any key in src/update/trusted-keys.ts — installed daemons would refuse this release`);

  const lines = sums.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`${sumsPath} lists no files`);
  for (const line of lines) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m === null) throw new Error(`unreadable line in ${sumsPath}`);
    const name = m[2].trim();
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new Error(`${sumsPath} names a file outside its own directory: ${name}`);
    const actual = createHash('sha256').update(readFileSync(join(dirname(sumsPath), name))).digest('hex');
    if (actual !== m[1]) throw new Error(`${name} does not match its line in ${sumsPath}`);
  }
  return keyId;
}

export function main(argv, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }, keysFile = TRUSTED_KEYS_FILE) {
  try {
    const keys = readTrustedKeys(readFileSync(keysFile, 'utf8'));
    if (keys.length === 0) throw new Error('TRUSTED_RELEASE_KEYS is empty');
    if (argv.length === 1 && argv[0] === '--no-placeholder') {
      if (keys.some((k) => k.publicKey === PLACEHOLDER)) {
        throw new Error(`src/update/trusted-keys.ts still contains ${PLACEHOLDER} — replace it with the real release public key before releasing`);
      }
      const bad = keys.filter((k) => usableKey(k) === null).map((k) => k.id);
      if (bad.length > 0) throw new Error(`not usable Ed25519 public keys: ${bad.join(', ')}`);
      io.out(`trusted release keys: ${keys.map((k) => k.id).join(', ')}\n`);
      return 0;
    }
    if (argv.length !== 1 || argv[0].startsWith('-')) {
      io.err('usage: verify-release.mjs <SHA256SUMS>      checks <SHA256SUMS>.sig and every listed file\n       verify-release.mjs --no-placeholder  fails while the placeholder key is present\n');
      return 2;
    }
    io.out(`verified ${argv[0]}: signed by "${verifyRelease(argv[0], keys)}", every listed file matches\n`);
    return 0;
  } catch (err) {
    io.err(`verify-release: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
