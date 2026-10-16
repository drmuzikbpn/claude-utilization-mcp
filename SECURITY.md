<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 Even Seal Productions -->

# Security

Usage Deck holds an access token for every computer it is paired with, and can pause or freeze
Claude Code sessions on them. Treat a report about it as you would one about the daemon.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (*Security › Report a vulnerability*). You should hear back within a
few days.

In scope: the iPhone and Apple Watch app (`usage-ios` branch), the daemon (`main`), the pairing
exchange between them, and the CI that signs and uploads builds.

## How it is protected

- **Pairing:** a one-time code from `claude-usage pair`, redeemed over HTTPS pinned to the
  computer's certificate. The QR code never carries the token.
- **Transport:** every request after pairing goes over HTTPS pinned to that certificate, with the
  token as a bearer header. No plain HTTP off loopback.
- **Storage:** tokens live in the iPhone Keychain, this device only: not synced to iCloud and not
  shared with the watch, the widgets or any other app.
- **Nothing collected:** the app talks only to the computers you pair. See [PRIVACY.md](PRIVACY.md).
- **Builds:** CI signs and uploads to App Store Connect from the `release-ios` environment, which
  only this branch can enter and which holds only the App Store signing material.

The full threat model, including the daemon's side, is in
[docs/security.md on `main`](https://github.com/drmuzikbpn/usage-deck/blob/main/docs/security.md).
