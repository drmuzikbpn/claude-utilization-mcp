#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Sign a release file with the project's Ed25519 key (§23.59).
 *
 *     RELEASE_SIGNING_KEY="$(cat release-key.pem)" node scripts/sign-release.mjs release/SHA256SUMS
 *
 * writes `release/SHA256SUMS.sig`: the base64 of the 64-byte signature over the exact bytes
 * of the file, and a newline. That is the whole format.
 *
 * The private key is a PKCS#8 PEM (the format written by
 * `openssl genpkey -algorithm ed25519`) and is read from the environment variable
 * `RELEASE_SIGNING_KEY` **only** — never from an argument, where it would land in shell
 * history and in the process table, and it is never printed, not even in an error.
 *
 *     node scripts/sign-release.mjs --public-key
 *
 * prints the matching public key in the form `src/update/trusted-keys.ts` wants. A public
 * key is not a secret.
 *
 * Stdlib only, so the publish job can run it without installing anything.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const KEY_ENV = 'RELEASE_SIGNING_KEY';

/** Thrown for every refusal; its message never contains key material. */
export class SignError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignError';
  }
}

/** The private key from the environment, or a `SignError` that says what is wrong with it. */
export function loadSigningKey(env = process.env) {
  const pem = env[KEY_ENV];
  if (typeof pem !== 'string' || pem.trim().length === 0) {
    throw new SignError(`${KEY_ENV} is not set — the signing key is read from the environment, never from an argument`);
  }
  let key;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // The underlying error can quote the input. It is deliberately not passed on.
    throw new SignError(`${KEY_ENV} is not a PEM private key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new SignError(`${KEY_ENV} must be an Ed25519 key, not ${String(key.asymmetricKeyType)}`);
  }
  return key;
}

/** Base64 SPKI of the public half — the `publicKey` string for `trusted-keys.ts`. */
export function publicKeyOf(privateKey) {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}

/** The body of a `.sig` file for `data`. */
export function signatureFor(data, privateKey) {
  return `${sign(null, data, privateKey).toString('base64')}\n`;
}

export function main(argv, env = process.env, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }) {
  try {
    if (argv.length === 1 && argv[0] === '--public-key') {
      io.out(`${publicKeyOf(loadSigningKey(env))}\n`);
      return 0;
    }
    if (argv.length !== 1 || argv[0].startsWith('-')) {
      io.err('usage: sign-release.mjs <file>        writes <file>.sig\n       sign-release.mjs --public-key  prints the public key for trusted-keys.ts\n');
      return 2;
    }
    const file = argv[0];
    const key = loadSigningKey(env);
    const data = readFileSync(file);
    if (data.byteLength === 0) throw new SignError(`${file} is empty — refusing to sign nothing`);
    writeFileSync(`${file}.sig`, signatureFor(data, key), { mode: 0o644 });
    io.out(`signed ${file} -> ${file}.sig\n`);
    return 0;
  } catch (err) {
    io.err(`sign-release: ${err instanceof SignError ? err.message : `could not sign (${err?.code ?? 'error'})`}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
