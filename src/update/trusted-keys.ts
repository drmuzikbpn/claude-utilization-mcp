// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * The public keys a release must be signed with (§23.59).
 *
 * `SHA256SUMS` says what the tarball should hash to, but it is downloaded from the same
 * place as the tarball: whoever can replace one can replace the other. `SHA256SUMS.sig` is
 * an Ed25519 signature over the exact bytes of `SHA256SUMS`, made in CI with a private key
 * that is not in this repository. The matching public keys are compiled in here, so an
 * installed daemon accepts an update only from someone who holds one of them.
 *
 * ## Format
 *
 * `publicKey` is the base64 body of the key's SPKI PEM — the text between
 * `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`, on one line. For Ed25519
 * that is always 60 characters starting `MCowBQYDK2VwAyEA`. Print it for a private key
 * with:
 *
 *     RELEASE_SIGNING_KEY="$(cat release-key.pem)" node scripts/sign-release.mjs --public-key
 *
 * ## Rotation
 *
 * It is a list so a key can be replaced without stranding anyone: add the new key in one
 * release (signed with the old one), start signing with the new one in a later release,
 * and remove the old entry after that. A signature is accepted if **any** listed key
 * verifies it.
 */

export interface TrustedKey {
  /** A label for logs and error messages. Never secret. */
  id: string;
  /** Base64 SPKI, as described above. */
  publicKey: string;
}

/**
 * Stands in for the real release key until the owner generates one. It is not a key —
 * it does not even decode — so it can never verify anything: with only this entry present
 * every update is refused. The release workflow refuses to publish while it is here.
 */
export const RELEASE_PUBLIC_KEY_PLACEHOLDER = 'RELEASE_PUBLIC_KEY_PLACEHOLDER';

export const TRUSTED_RELEASE_KEYS: readonly TrustedKey[] = [
  { id: 'release-2026-10', publicKey: RELEASE_PUBLIC_KEY_PLACEHOLDER },
];
