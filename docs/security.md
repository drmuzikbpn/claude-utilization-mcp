# Security model

`claude-usage` runs as your user, reads your Claude Code credentials, and — when you ask
it to — listens on your tailnet and can stop your processes. This document says what it
defends against, what it does not, and where the sharp edges are.

## Threat model

### 1. Anything else on the tailnet

Once `config.bind` includes `tailscale`, every peer on your tailnet can reach the port.
Tailscale authenticates *devices*, not *intent*: a compromised laptop of yours, a shared
node, or a tailnet ACL that is broader than you think all reach the daemon.

**Defence:** every request from a non-loopback address requires
`Authorization: Bearer <token>`, including `GET`. The token is 32 random bytes
(`crypto.randomBytes(32)`, base64url) minted at install, stored in `config.json` at mode
`0600`, and compared in constant time (sha256 digests through `timingSafeEqual`). An empty
configured token never matches anything, so a daemon that has never been installed is not
accidentally open.

**Not defended:** a tailnet peer that has the token is fully trusted — it can pause and
hard-freeze every session on the machine. Treat the pairing QR like a password. Rotate with
`claude-usage configure rotate-token` (every paired device must re-pair).

### 2. Local browsers, web pages and DNS rebinding

A page you visit can make requests to `http://127.0.0.1:47291` from your own browser. DNS
rebinding can make an attacker-controlled name resolve to a loopback or tailnet address, so
"the request came from loopback" is not by itself proof of a friendly caller.

**Defence, three layers:**

- **Host allowlist.** The `Host` header must name an address the daemon is actually bound
  to, or `localhost` / `127.0.0.1` / `::1`, or the machine's MagicDNS name — including the
  port when one is present. A rebound `evil.test` name fails with `421`. `0.0.0.0` and `::`
  are never accepted as `Host` values even when bound.
- **Origin rejection.** Any request carrying an `Origin` header at all is `403`. Browsers
  attach `Origin` to cross-site requests; we serve no browser callers, so there is no
  legitimate `Origin`.
- **No CORS headers, ever.** Even if a request slipped through, the browser could not read
  the response.

The impact being defended is **disclosure** — local paths, project names, session ids,
token counts — and **attacker-forced upstream fetches** via `POST /v1/refresh`. That POST
needs the token even from loopback. It also forces a credential-store read (§23.31); at one
per 10 s that is a Keychain lookup, not a prompt, and it discloses nothing to the caller.

### 3. Other users on the same machine

Anyone who can read your files can read the bearer token; anyone who can run as your uid
can do everything the daemon can.

**Defence:** file modes, below. Hard freeze additionally refuses to signal any pid not
owned by the daemon's own uid (`409 conflict`), so it can never be used to stop another
user's processes.

**Not defended:** a root user, or any process running as you. That is out of scope for a
user-level daemon.

### 4. Models running in your sessions

The MCP server is read-mostly on purpose. There is **no** tool to pause, resume or freeze a
session: `get_limits`, `get_summary`, `get_tokens`, `get_sessions`, `refresh_limits`.
Session control belongs to the human, through the CLI or the dashboard.

## What the token protects

| Reachable without the token | Requires the token |
| --- | --- |
| `GET`/`HEAD` from loopback: `/health`, `/v1/limits`, `/v1/summary`, `/v1/tokens`, `/v1/config`, `/v1/sessions`, `/v1/sessions/{id}/gate`, `/v1/pause/rules`, `/v1/events` | every request from a non-loopback address, `GET` included |
| `POST` from loopback to `/v1/sessions/register`, `/v1/sessions/{id}/heartbeat`, `/v1/sessions/{id}/end` | every mutating request: `POST /v1/refresh`, `POST /v1/pause`, `POST /v1/resume`, `DELETE /v1/pause/rules/{id}`, the `/v1/sessions/{id}/pause|resume` sugar |

The loopback `GET` exemption is what keeps the hook, the status line and
`curl localhost:47291/health` zero-config. The three exempt `POST`s are the hook's own
session bookkeeping: Claude Code runs `claude-usage hook` as a bare command with no way to
hand it a credential, the calls are write-only, keyed by a session id the caller must
already know, and they return no data. From the tailnet they require the token like
everything else. Pause and resume are deliberately not on that list.

Loopback is determined from the socket's remote address, never from a header.

## What is never exposed

- **The OAuth access token** is read from the macOS Keychain item `Claude Code-credentials`
  or from `~/.claude/.credentials.json`, used as a `Bearer` header for exactly one
  read-only request (`GET https://api.anthropic.com/api/oauth/usage`), and never stored,
  logged, written to disk or serialized into any response. `claude-usage` never refreshes
  tokens — Claude Code owns refresh — and never calls any other Anthropic endpoint.
- **The bearer token** is redacted to `"<redacted>"` in `GET /v1/config`. It appears in
  clear text in exactly two places: `config.json` (`0600`) and the pairing payload you
  asked for.
- **Prompt and transcript content.** The spend scanner reads `message.usage` counters,
  model names, ids and timestamps. No prompt or response text is parsed, stored or served.
- **Test fixtures** under `test/fixtures/` contain no credentials and no real prompt text.

What *is* exposed to a holder of the token: hostname, the `oauthAccount` identity block
from `~/.claude.json` (email address, account/organization UUIDs, display name), absolute
`cwd` and transcript paths, project and worktree names, pids, models and token counts.
That is disclosure worth protecting, and it is why non-loopback `GET` needs the token.

## File modes

| Path | Mode |
| --- | --- |
| `~/.config/claude-usage/` | `0700` |
| `config.json` (holds the bearer token) | `0600` |
| `state.json`, `sessions.json`, `pause.json`, `daemon.json`, `hook-state.json` | `0600` |
| `paused/<sessionId>` markers (dir and files) | `0700` / `0600` |
| `~/Library/Logs/claude-usage/` (macOS) | `0700` |
| `~/.claude.json` | mode preserved (Claude Code writes it `0600`) |
| `~/.claude/settings.json` and its one-time `.bak` | source mode preserved |
| unit files (plist / systemd) | `0644` — they contain no secrets |

Every one of those writes is atomic: a temp file in the same directory, `chmod`, then
`rename(2)`. No `.bak` is written for `~/.claude.json` on purpose — a `0644` backup of a
`0600` file would leak it.

## Hard freeze and the escape hatch

Hard pause sends `SIGSTOP` to the tool subprocesses **below** a session, deepest first so
nothing gets reparented onto a running shell mid-freeze. The session's own `claude` process
is deliberately left running: stopping it would suspend the user's foreground job and cost
them their terminal until they typed `fg`. The next tool call is stopped by the `PreToolUse`
gate instead. Resume sends `SIGCONT` nearest-first. `ESRCH` and `EPERM` are ignored — a
process that already exited is not an error.

A stopped process cannot ask to be resumed. So there are four safety nets:

1. `SIGTERM`/`SIGINT` shutdown SIGCONTs every recorded `frozenPids` before anything else.
2. `claude-usage uninstall` and `configure service off` do the same.
3. At startup the daemon re-resolves and re-freezes only sessions that still match a live
   rule, and SIGCONTs any recorded pid that no longer does (orphan sweep).
4. **`claude-usage resume --all` works with no daemon at all.** It reads `sessions.json`
   and `pause.json` off disk, SIGCONTs everything recorded and clears every rule.

Net 4 is the one that matters, because nets 1–3 all require the daemon to be alive. If the
daemon is killed with `-9`, crashes, or is removed mid-freeze, this is how you get your
sessions back. Run it before you start debugging anything else.

Additional refusals, checked *before* any rule is created:

- `discovered: "transcript"` sessions have no trusted pid → `409`.
- A pid not owned by the daemon's uid → `409`.
- A session that is unknown or has already exited → `410`, and no rule is created.

## Auto-update integrity

**Landing in the next merge** — the release pipeline and updater are being implemented
concurrently. The design, so you can judge it before it ships:

- Releases are GitHub Releases on a repo pinned in code (`autoUpdate.repo`, overridable for
  forks), carrying the `npm pack` tarball and a `SHA256SUMS` file.
- Downloads are TLS only. The sha256 from `SHA256SUMS` on the same release is verified
  before extraction; a mismatch deletes the download and reports `update.state: "error"`.
- The new version is extracted into `versions/<v>/` and smoke-tested
  (`node bin/claude-usage --version`) before `current` is atomically repointed. A failed
  smoke test means no repoint.
- The previous two versions are kept; `claude-usage rollback` repoints `current` back.
- An update never restarts the daemon while any session is hard-frozen
  (`state: "deferred"`, `deferredReason: "hard_frozen_sessions"`), re-checked every 30 s.
- The updater disables itself automatically when there is no `current` symlink — i.e. when
  you did not install through `claude-usage install` — and with
  `claude-usage configure autoupdate off`.

**Honest limitation:** sha256 from the same release over TLS proves the tarball matches
what that release published; it does not prove who published it. Anyone who can publish a
release to the pinned repo can push code to every installation that has auto-update on.
Signature verification (minisign) is the planned fix and is tracked as a follow-up. If that
trade-off is not acceptable in your environment, run `claude-usage configure autoupdate
off` and update through npm.

## Reporting a security issue

Please **do not** open a public GitHub issue for a vulnerability. Use GitHub's private
vulnerability reporting on
<https://github.com/drmuzikbpn/claude-utilization-mcp> (Security → Report a
vulnerability), which reaches the maintainers privately.

Useful things to include: the version (`claude-usage --version`), your platform, whether
the daemon was bound to a tailnet address, and the smallest request or sequence that
reproduces it. If a proof of concept touches credentials, describe it rather than pasting
it.

Out of scope: attacks that require root or an already-compromised user account on the same
machine; anything that requires the bearer token you handed out; and the trust you place in
your own tailnet ACLs.
