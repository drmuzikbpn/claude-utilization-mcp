# Security

Usage Deck holds a bearer token for every daemon it is paired with and can pause or freeze
processes on those machines. Treat a report about it as you would one about the daemon.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (*Security › Report a vulnerability*). You should hear back within a
few days.

In scope: the deck (`usage-android` branch), the daemon (`main`), the pairing exchange between them,
the self-update path, and the CI that signs releases.

## How it is protected

**Pairing and transport**

- The only way to pair is `claude-usage pair`. Its QR or link
  (`usagedeck://pair?v=2&name&addrs&port&fp&code`) carries no token: it holds a one-time code that
  expires after five minutes and the SHA-256 of the daemon certificate's public key. The deck
  redeems the code with `POST /v1/pair` over HTTPS pinned to that key, and never logs or stores
  the code.
- Every request and the event stream go over HTTPS pinned to that same key. There is no
  plain-HTTP path to a daemon: the clients carry TLS-only connection specs, do not follow
  redirects, and cannot be built for a machine without a pin. The older
  `claude-usage configure pairing` QR is refused, and a machine that was paired that way is shown
  as needing to be paired again and is never contacted.
- The manifest has to permit cleartext because the captive-portal WebView loads a venue's login
  page over plain HTTP from an address nobody can list in advance, and Android cannot grant that
  to one WebView only. Nothing else may use it; a test fails the build if any other shipped
  source names an `http://` URL. The WebView itself cannot read files or content URIs, refuses
  every scheme but http/https, exposes no JavaScript interface, and wipes its cookies, storage and
  cache when it closes.
- What a daemon sends is bounded: reply sizes, event-stream line and event sizes, the length of a
  machine name (control and direction characters are dropped) and the number of addresses in a
  link.
- A pairing never silently replaces a machine. A sideloaded link that would replace one waits for
  an on-screen confirmation naming the old and the new machine, as does a scanned QR that would
  overwrite a machine paired under a different certificate. A release build accepts a sideloaded
  `pairing-import.json` only from its private files directory; only debug builds also read the
  external one.

**On the phone**

- Tokens, the install id and the exit PIN live in `EncryptedSharedPreferences`, keyed from the
  AndroidKeyStore. If the keystore cannot open the store, a release build shows a storage error
  and does not start; it never falls back to an unencrypted file. Backups and device-to-device
  transfer are off.
- The kiosk exit PIN is stored with PBKDF2-HMAC-SHA256. Five wrong attempts lock the gate for five
  minutes, doubling each round, timed on a monotonic clock so changing the date does not end it.
  Changing the PIN requires the current one, counted against the same lockout. A provisioned
  kiosk asks for a PIN the first time it starts.
- Only the launcher activity and the device-admin receiver (system-only) are exported.

**Updates and releases**

- Before installing an update the deck checks its sha256, that it is this package with a higher
  version code, and that it is signed by the key the installed app trusts or one its signing
  lineage vouches for. Android's installer enforces the signature again.
- Releases are built and signed by CI from the `usage-android` branch, in a job that runs only
  after the tests, in its own environment, with first-party steps. The signing key exists only as
  CI secrets and in the owner's password manager; the committed `app/signing/usage-deck.lineage`
  contains certificates and rotation proofs only.

## What it does not protect against

- **Anyone standing at the deck can pause and resume sessions, change settings, manage wifi and
  unpair a machine.** That is what the deck is for; put it where that is acceptable. Only leaving
  the kiosk is behind the PIN.
- **A lost or stolen phone.** Its tokens are encrypted at rest, but assume they are compromised:
  run `claude-usage configure rotate-token` on **each** machine the phone was paired with, then
  pair the replacement with `claude-usage pair`. Rotating invalidates the old token immediately.
- **USB debugging and an unlocked bootloader.** The setup guide leaves USB debugging on, because
  it is the recovery path for a forgotten PIN, and the Nexus 5X's bootloader has to be unlocked to
  flash LineageOS. Someone with the phone, a cable and time can therefore get past the kiosk and,
  with more effort, at the app's data. A six-digit PIN is a speed bump against a determined
  offline attack, not a wall. Treat physical possession as compromise and rotate, as above.
- **A daemon reachable from the open internet.** It is meant to listen on localhost, the LAN and
  the Tailscale tailnet only.
