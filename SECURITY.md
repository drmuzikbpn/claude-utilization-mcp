# Security

Usage Deck holds a bearer token for every daemon it is paired with and can pause or freeze
processes on those machines. Treat a report about it as you would one about the daemon.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (*Security › Report a vulnerability*). You should hear back within a
few days.

In scope: the deck (`usage-android` branch), the daemon (`main`), the pairing exchange between them,
the self-update path, and the CI that signs releases.

## What we already assume

- The daemon is reachable only on localhost, the LAN and the Tailscale tailnet, never the open
  internet. A deck paired with `claude-usage pair` talks to it over HTTPS pinned to the SHA-256 of
  the daemon certificate's public key, on the LAN or the tailnet.
- A `claude-usage pair` QR holds a one-time code that expires after five minutes; the deck never
  logs or stores it. A legacy `claude-usage configure pairing` QR is a live bearer token: anyone
  who scans it can pause your sessions. Rotate it with `claude-usage configure rotate-token` if it
  was ever exposed.
- Releases are signed with a key that lives only in CI secrets and 1Password; the committed
  `app/signing/usage-deck.lineage` contains certificates and proofs only.
