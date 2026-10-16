# Security model

`claude-usage` runs as your user, reads your Claude Code credentials, and — when you ask
it to — listens on your LAN or tailnet and can stop your processes. This document says what it
defends against, what it does not, and where the sharp edges are.

## Threat model

### 1. Anything else on the tailnet

Once `config.bind` includes `tailscale`, every peer on your tailnet can reach the port.
Tailscale authenticates *devices*, not *intent*: a compromised laptop of yours, a shared
node, or a tailnet ACL that is broader than you think all reach the daemon.

**Defence:** every request requires `Authorization: Bearer <token>`, including `GET`, from
the tailnet and from loopback alike (§23.55), and nothing but HTTPS with a pinned certificate
is served to the tailnet (§23.57). The token is 32 random bytes
(`crypto.randomBytes(32)`, base64url) minted at install, stored in `config.json` at mode
`0600`, and compared in constant time (sha256 digests through `timingSafeEqual`). An empty
configured token never matches anything, so a daemon that has never been installed is not
accidentally open.

**Not defended:** a tailnet peer that has the token is fully trusted — it can pause and
hard-freeze every Claude Code session on the machine. A lost or stolen phone is exactly this
case: rotate with `claude-usage configure rotate-token`, which takes effect immediately and
makes every paired device pair again.

### 1a. Anything else on the LAN (§23.44, §23.45)

`config.bind: ["127.0.0.1", "lan"]` puts the daemon on your Wi-Fi so the iPhone app can reach
it. Everything in §1 applies, and a Wi-Fi network has a wider audience than a tailnet:
guests, IoT devices, the café you take the laptop to. `lan` only ever picks an RFC 1918
address, never a VM bridge or VPN tunnel. When you take the laptop to another network, the
daemon listens there too, on that network's private address.

**Defence:**

- The bearer gates every request.
- **TLS only (§23.57).** Every non-loopback address gets an HTTPS listener (`tls.port`,
  default `port + 1`) and **no plain-HTTP listener at all**; plain HTTP exists on loopback
  only. The ECDSA P-256 key is generated once, kept at `0600`, and its SPKI SHA-256
  fingerprint reaches the app inside the pairing QR. The app pins that fingerprint and trusts
  nothing else, so a machine on the same Wi-Fi can neither read the bearer nor impersonate
  the daemon. To rotate the key, delete `tls-key.pem` and `tls-cert.pem` and restart the
  daemon. Every app must then pair again. If there is no TLS identity, non-loopback addresses
  are simply not served.
- **No wildcard, no public address.** `bind` entries `0.0.0.0`, `::` or any publicly routable
  address are a configuration error unless `"allowPublicBind": true` is written into
  `config.json` by hand; a keyword that resolves to one is skipped. The `tailscale` keyword
  only accepts a `100.64.0.0/10` address on a `tailscale*` interface or reported by the
  `tailscale` CLI, which is run by absolute path.

**Visible on the network:** the machine's `.local` name, which macOS already announces over
mDNS, and the fact that ports 47291/47292 are open. The `.local` name goes in the pairing
link because the app can use it as an address.

### 1b. The pairing code — the one bearer-less mutating endpoint (§23.47)

`POST /v1/pair` trades a code for the bearer **without** a bearer. It is the only endpoint
that works that way (apart from a liveness-only `GET /health`), so its rules are strict:

- Codes are minted only by `POST /v1/pair/code`, which needs the bearer **and** loopback,
  which in practice means `claude-usage pair` on the machine itself. When `pair` ends without
  the phone pairing (Enter, Ctrl-C, an error) it revokes the code with `DELETE /v1/pair/code`
  (§23.63).
- A code is 128 random bits, lives only in daemon memory, expires after 5 minutes, works
  once, and is voided when a new one is minted.
- `/v1/pair` answers only on an HTTPS listener (plain HTTP gets `403`), so the bearer it
  returns never crosses the network in the clear.
- After 5 failed attempts in a minute, a remote address gets `429` for the rest of that
  minute, even with the correct code. The failure table holds at most 1024 addresses; beyond
  that a new address gets `429` until old entries age out. Codes are compared in constant time. The Host
  allowlist and the Origin refusal still apply.
- The code and the token are never logged or printed. `claude-usage pair` puts the code
  only inside the QR's modules and the **Copy link** button's attribute (never page text),
  on a page served once from `127.0.0.1` at a random 128-bit path with
  `Cache-Control: no-store`. The page's only script is allowed by hash and may talk to its
  own origin only. Once the code is used or expires, or the page server goes away, the
  script removes the QR and the link from the page (§23.52). A copied link sits in the
  clipboard (and Universal Clipboard) until something replaces it; it is single-use and
  dies with the code after 5 minutes. That URL never goes on a command line or to the
  terminal: the browser is pointed at a `0600` redirect file in a fresh `0700` temp directory,
  deleted when the page closes.

**Not defended:** someone who can see your screen in the 5 minutes before the phone scans
the code. Treat the page like a password. If it was shown on a call, run `claude-usage pair`
again, which voids the old code. **Other local users on the same machine** are not a defended
audience either (see §3): the page listens on loopback, which every local account can reach,
and while the random path and single view make a hit unlikely, a local user who can watch
your processes or your browser is outside what a user-level daemon can protect against.

### 2. Local browsers, web pages and DNS rebinding

A page you visit can make requests to `http://127.0.0.1:47291` from your own browser. DNS
rebinding can make an attacker-controlled name resolve to a loopback or tailnet address, so
"the request came from loopback" is not by itself proof of a friendly caller.

**Defence, three layers:**

- **Host allowlist.** The `Host` header must name an address the daemon is actually bound
  to, or `localhost` / `127.0.0.1` / `::1`, or the machine's MagicDNS name, or its `.local`
  name while `bind` has `lan` — including the
  port when one is present. A rebound `evil.test` name fails with `421`. `0.0.0.0` and `::`
  are never accepted as `Host` values even when bound.
- **Origin rejection.** Any request carrying an `Origin` header at all is `403`. Browsers
  attach `Origin` to cross-site requests; we serve no browser callers, so there is no
  legitimate `Origin`.
- **No CORS headers, ever.** Even if a request slipped through, the browser could not read
  the response.

- **Fetch metadata (§23.55).** Any `Sec-Fetch-Site` other than `none` is `403`, token or
  not. Browsers attach it to every request a page makes and scripts cannot remove it.
- **The bearer, from loopback too (§23.55).** A page cannot read `config.json`, so it cannot
  present the token, so it gets `401` — including on the event stream, whose slots it
  therefore cannot occupy.

The impact being defended is **disclosure** — local paths, project names, session ids,
token counts — **session control** (pause, hard freeze), and **attacker-forced upstream
fetches** via `POST /v1/refresh`.

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
| `GET`/`HEAD /health` with **no** `Authorization` header, which answers `{"ok": true}` and nothing else · `POST /v1/pair` over HTTPS with a valid one-time code (§1b) | everything else, from loopback and from the network alike — every `GET` (`/health` in full, `/v1/limits`, `/v1/summary`, `/v1/tokens`, `/v1/config`, `/v1/sessions`, `/v1/sessions/{id}/gate`, `/v1/pause/rules`, `/v1/events`) and every write (`/v1/sessions/register`, `…/heartbeat`, `…/end`, `…/gate`, `POST /v1/refresh`, `POST /v1/limits/observed`, `POST /v1/pause`, `POST /v1/resume`, `DELETE /v1/pause/rules/{id}`, the `/v1/sessions/{id}/pause|resume` sugar, `POST /v1/pair/code`, which is also loopback-only) |

Until §23.55 the hook's three session-bookkeeping `POST`s and every loopback `GET` were
exempt, on the reasoning that a bare hook command could not be handed a credential. It can:
it runs as the same user and reads the `0600` `config.json`, as the status line already did.
A hook that cannot read it stays silent and exits 0, like a hook with no daemon.

A `/health` request that carries a token which is **wrong** is `401`, not liveness, so a
paired app still learns that its token was rotated.

## What a token holder still cannot do (§23.56)

The token is also what a lost phone carries, so the session endpoints do not take it on
trust:

- a session id must be a UUID, in the body and in every URL path; it is checked again before
  it is used to build any file path;
- every string field is bounded and checked; a transcript path is only kept inside
  `config.projectsDir`; at most 256 sessions are held, and pid-less ones that stop
  heart-beating are dropped after two hours;
- a pid is only kept for a **Claude Code** process of the same user — `argv[0]` named
  `claude`, a binary under the native installer's `…/claude/versions/`, or Node running
  `@anthropic-ai/claude-code/…cli.js` — or the nearest such ancestor of the reported pid;
- the pid's start time and the machine's boot id are recorded with it, and re-checked
  before every freeze, thaw and liveness verdict. A recycled pid is a dead session, and
  pids recorded before a reboot are discarded without being signalled;
- the gate's `GET` only reads; recording the tool being gated is a `POST`.

## The local clients check who they are talking to (§23.61)

`daemon.json` names the port, and it can outlive the daemon (a crash, a reboot). Before a
local client sends the token to that port it sends a random challenge to `GET /health`; only a
listener holding the same token can answer with `HMAC-SHA256(token, label + challenge)`. A
`daemon.json` whose process is gone, or belongs to another user, is ignored outright.

## What is never exposed

- **The OAuth access token** is read from the macOS Keychain item `Claude Code-credentials`
  or from `~/.claude/.credentials.json`, used as a `Bearer` header for exactly one
  read-only request (`GET https://api.anthropic.com/api/oauth/usage`), and never stored,
  logged, written to disk or serialized into any response. `claude-usage` never refreshes
  tokens — Claude Code owns refresh — and never calls any other Anthropic endpoint.
- **The bearer token** is redacted to `"<redacted>"` in `GET /v1/config` and in
  `claude-usage config`. It appears in clear text in exactly two places: `config.json`
  (`0600`) and the `POST /v1/pair` response (HTTPS only) to an app holding a valid one-time
  code. The pairing link from `claude-usage pair` never contains it. The old
  `configure pairing` command, whose QR code carried it, has been removed (§23.57).
- **Error detail.** A `500` says `internal error` and nothing more; the exception goes to the
  daemon's own log.
- **Prompt and transcript content.** The spend scanner reads `message.usage` counters,
  model names, ids and timestamps. No prompt or response text is parsed, stored or served.
- **Test fixtures** under `test/fixtures/` contain no credentials and no real prompt text.

What *is* exposed to a holder of the token: hostname, the `oauthAccount` identity block
from `~/.claude.json` (email address, account/organization UUIDs, display name), absolute
`cwd` and transcript paths, project and worktree names, pids, models and token counts.
That is disclosure worth protecting, and it is why every `GET` needs the token.

## File modes

| Path | Mode |
| --- | --- |
| `~/.config/claude-usage/` | `0700` |
| `config.json` (holds the bearer token) | `0600` |
| `tls-key.pem`, `tls-cert.pem` (HTTPS identity, §23.45) | `0600` |
| `state.json`, `sessions.json`, `pause.json`, `daemon.json`, `hook-state.json` | `0600` |
| `paused/<sessionId>` markers (dir and files) | `0700` / `0600` |
| `~/Library/Logs/claude-usage/` (macOS) | `0700` |
| `~/.claude.json` | mode preserved (Claude Code writes it `0600`) |
| `~/.claude/settings.json` and its one-time `.bak` | source mode preserved |
| temp files of every atomic write | random name, created exclusively (`O_EXCL`) |
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

Before any signal is sent, each pid is checked to still be the process that was recorded —
same start time, same user — and the daemon's own pid and its ancestors are never signalled
(§23.56). The list of pids about to be stopped is written to `sessions.json` **before** the
first `SIGSTOP`, so a crash mid-freeze cannot leave a stopped process nobody knows about.

A stopped process cannot ask to be resumed. So there are five safety nets:

1. `SIGTERM`/`SIGINT` shutdown SIGCONTs every recorded `frozenPids` before anything else.
   An uncaught exception or unhandled rejection does the same before the process exits, and
   so does a daemon that fails to finish starting.
2. `claude-usage uninstall` and `configure service off` do the same.
3. At startup the daemon re-resolves and re-freezes only sessions that still match a live
   rule, and SIGCONTs any recorded pid that no longer does (orphan sweep).
4. **`claude-usage resume --all` works with no daemon at all.** It reads `sessions.json`
   and `pause.json` off disk, SIGCONTs everything recorded and clears every rule.
5. After a reboot nothing is stopped any more, so recorded pids are simply forgotten.

Net 4 is the one that matters, because nets 1–3 all require the daemon to be alive. If the
daemon is killed with `-9`, crashes, or is removed mid-freeze, this is how you get your
sessions back. Run it before you start debugging anything else.

Additional refusals, checked *before* any rule is created:

- `discovered: "transcript"` sessions have no trusted pid → `409`.
- A pid not owned by the daemon's uid → `409`.
- A session that is unknown or has already exited → `410`, and no rule is created.

## Auto-update integrity

- Releases are GitHub Releases on a repo pinned in code (`autoUpdate.repo`, overridable for
  forks), carrying the `npm pack` tarball, a `SHA256SUMS` file and `SHA256SUMS.sig`.
- **Signed (§23.59).** `SHA256SUMS.sig` is an Ed25519 signature over the exact bytes of
  `SHA256SUMS`, made in CI with a private key kept as the `RELEASE_SIGNING_KEY` secret of
  the `release-daemon` environment, which only `main`'s release job can enter and which holds
  no other secret (the Android and iOS signing material lives in their own environments). The updater verifies it with `node:crypto` against the public
  keys compiled into `src/update/trusted-keys.ts` **before** it believes a checksum or
  extracts anything. A missing, malformed or unknown signature is refused, the download is
  deleted and nothing is applied. The keys are a list so one can be rotated.
- Downloads are TLS only. The tarball must then match its line in the signed `SHA256SUMS`.
- The archive is listed before it is extracted and refused if any member is absolute,
  contains `..`, or lies outside `package/`; a symlink in the result is refused too, and
  ownership is never taken from the archive.
- Dependencies are installed with `npm ci --omit=dev --ignore-scripts` from the
  `npm-shrinkwrap.json` inside the signed tarball — the exact tree CI tested.
- The new version is extracted into `versions/<v>/` and smoke-tested
  (`node bin/claude-usage --version`) before `current` is atomically repointed. A failed
  smoke test means no repoint.
- The previous two versions are kept; `claude-usage rollback` repoints `current` back.
- An update never restarts the daemon while any session is hard-frozen
  (`state: "deferred"`, `deferredReason: "hard_frozen_sessions"`), re-checked every 30 s.
- The updater disables itself automatically when there is no `current` symlink — i.e. when
  you did not install through `claude-usage install` — and with
  `claude-usage configure autoupdate off`.
- **The release pipeline** builds and tests in a job with a read-only token and no secrets,
  and signs and publishes in a separate job that runs none of the project's dependencies.
  Every GitHub Action is pinned to a commit SHA. The package is `private` and is not
  published to npm.

**Remaining trust:** whoever holds the release signing key can ship code to every
installation that has auto-update on. That is the point of the key; keep it out of anywhere
but the `release-daemon` environment. The signature protects the release files from
tampering, not from the account that publishes them: anyone who can merge to `main`, which
today means the owner's GitHub account, can publish an update. Run `claude-usage configure autoupdate off` if you would rather review
and update by hand.

## Reporting a security issue

Please **do not** open a public GitHub issue for a vulnerability. Use GitHub's private
vulnerability reporting on
<https://github.com/drmuzikbpn/usage-deck> (Security → Report a
vulnerability), which reaches the maintainers privately.

Useful things to include: the version (`claude-usage --version`), your platform, whether
the daemon was bound to a LAN or tailnet address, and the smallest request or sequence that
reproduces it. If a proof of concept touches credentials, describe it rather than pasting
it.

Out of scope: attacks that require root or an already-compromised user account on the same
machine; anything that requires the bearer token you handed out; and the trust you place in
your own tailnet ACLs.
