# Security

Usage Deck holds a bearer token for every daemon it is paired with and can pause or freeze
processes on those machines. Treat a report about it as you would one about the daemon.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (*Security › Report a vulnerability*). You should hear back within a
few days.

In scope: the deck (`usage-deck` branch), the daemon (`main`), the pairing exchange between them,
the self-update path, and the CI that signs releases.

## What we already assume

- The daemon is reachable only on localhost, the LAN and the Tailscale tailnet, never the open
  internet; the deck talks to it over the tailnet.
- A pairing QR is a live bearer token. Anyone who scans it can pause your sessions. Rotate it with
  `claude-usage configure rotate-token` if it was ever exposed.
- Releases are signed with a key that lives only in CI secrets and 1Password; the committed
  `app/signing/usage-deck.lineage` contains certificates and proofs only.
