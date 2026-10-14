# Security

`claude-usage` runs a local daemon that reads your Claude Code credentials, holds a bearer
token, can serve usage data to your own phone over your Wi-Fi or Tailscale tailnet, and can
pause or `SIGSTOP` processes on the machine it runs on. Treat a report about any of that as
security-relevant.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (*Security › Report a vulnerability*). You should hear back within a
few days. Include the version (`claude-usage --version`), your platform and the smallest
sequence that reproduces it; if a proof of concept touches credentials, describe it rather than
pasting it.

In scope, all in this one repository:

- the daemon, CLI, hooks and MCP server — branch `main`;
- the Android dashboard — branch `usage-android`;
- the iPhone and Apple Watch app — branch `usage-ios`;
- the pairing exchange between them, the self-update path, and the CI that signs and publishes
  releases.

## What the design assumes and guarantees

- **Every request needs the bearer token, from this machine too.** Loopback is not trusted:
  any local process, and any web page you have open, can reach `127.0.0.1`. The hook, the
  status line, the MCP server and the CLI read the token from `config.json`, which is mode
  `0600`. The only exceptions are `POST /v1/pair` (below) and a `GET /health` that, without a
  token, says `{"ok": true}` and nothing else. A request a web page started (an `Origin`
  header, or `Sec-Fetch-Site` other than `none`) is refused even with the token.
- **Only HTTPS leaves the machine.** Plain HTTP is served on loopback alone. Every address
  another device can reach — your LAN address, your tailnet address — is HTTPS with a
  self-signed certificate that the paired app pins by its SPKI fingerprint. The daemon refuses
  to listen on a wildcard or publicly routable address unless `config.json` says
  `"allowPublicBind": true`.
- **Pairing never shows the token.** `claude-usage pair` displays a QR code holding a one-time,
  five-minute, 128-bit code, the addresses and the certificate fingerprint. The app trades the
  code for the token over pinned HTTPS; the code works once, and repeated wrong guesses from one
  address are rate-limited.
- **Credentials.** The Claude Code OAuth token is read from the macOS keychain, or from
  `~/.claude/.credentials.json` on Linux, used for a single `GET /api/oauth/usage`, and never
  written to disk, logged, refreshed or sent anywhere else.
- **Releases are signed.** Each release carries `SHA256SUMS.sig`, an Ed25519 signature over
  `SHA256SUMS`. The self-updater checks it against public keys compiled into the daemon before
  it trusts a checksum or extracts anything, and installs dependencies with `npm ci` from the
  lockfile inside the signed tarball. An unsigned or wrongly signed release is refused.
- **Hard freeze is fenced.** It signals only Claude Code processes owned by the same user, and
  only while each process still has the start time recorded when it was registered; it never
  signals the daemon itself or its parents. `claude-usage resume --all` resumes everything with
  no daemon running.

## If a phone is lost or stolen

Run `claude-usage configure rotate-token` on the machine. The old token stops working at once
(the daemon is restarted, or signalled if you run it in the foreground), every open event
stream is dropped, and each device you still want must pair again with `claude-usage pair`.

`docs/security.md` has the full threat model.
