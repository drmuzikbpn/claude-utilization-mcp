# Security

`claude-usage` runs a local daemon that reads Claude Code credentials from the OS keychain, holds
a bearer token, serves usage data over the LAN and Tailscale tailnet, and can pause or `SIGSTOP`
processes on the machine it runs on. Treat a report about any of that as security-relevant.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (*Security › Report a vulnerability*). You should hear back within a
few days.

In scope: the daemon (`main`), the Android deck (`usage-deck`), the pairing exchange between them,
the hook and MCP integration points, the self-update path, and the CI that publishes releases.

## What we already assume

- The daemon binds loopback, the LAN address and the Tailscale tailnet, never the open internet.
  Exposing it beyond that is outside the threat model.
- Every mutating endpoint requires the bearer token, including from loopback. `GET /health` and
  the read endpoints require it from anything that is not loopback.
- A pairing QR is a live bearer token. Anyone who scans it can read your usage and pause your
  sessions. Rotate with `claude-usage configure rotate-token`, which invalidates every paired
  device.
- `config.json` is `0600` and holds the bearer token. Credentials from the keychain are read, used
  for a single `GET /api/oauth/usage`, and never written to disk or logged.
- Releases are built and published by GitHub Actions from `main`; the tarball's `SHA256SUMS` is
  verified by the self-updater before anything is extracted.
- The pause feature signals only processes owned by the same uid, and refuses anything else.
