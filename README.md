# claude-usage

**See how close your Claude account is to its rate limits, how many tokens your Claude Code
sessions are spending, and pause them, from your terminal, inside Claude Code itself, or
from your phone and watch.**

`claude-usage` is a small background service (a "daemon") for macOS and Linux. It reads the
same usage numbers `/usage` shows and the token counts in Claude Code's own transcripts,
and serves them on this machine only, unless you choose to let a phone in.

## What you get

| Where | What you see |
| --- | --- |
| **Inside Claude Code** | A one-line warning when a limit gets tight ("5h window 84%, prefer lighter work"), plus [MCP tools](#mcp-tools) a session can call itself. |
| **Status line** *(optional)* | `5h 42% · 7d 61%`, amber or red as you approach a limit. |
| **Terminal** | `claude-usage status`, `tokens`, `sessions`, `pause`, `resume`. |
| **iPhone and Apple Watch** | The **Usage Deck** app: limit rings, live sessions, pause and resume. |
| **Android** | The **Usage Deck** wall/kiosk dashboard. |

Tokens, not dollars: cost estimates are deliberately out of scope.

## Quick start

You need **Node 20 or newer** and **Claude Code** signed in on this machine.

**1. Install.**

```bash
git clone https://github.com/drmuzikbpn/claude-utilization-mcp.git
cd claude-utilization-mcp
npm ci && npm run build
node bin/claude-usage install
```

`install` asks before each change (answer **yes** to "LAN access for the iPhone app?" if you
want to use a phone). It copies itself into `~/.local/share/claude-usage`, starts the
background service, registers the Claude Code hook and MCP server, and puts `claude-usage`
on your PATH. Afterwards you can delete the checkout: the service updates itself from the
GitHub releases.

**2. Check it is running.** Open a new terminal (so the PATH change applies) and run:

```bash
claude-usage status
```

You should see `daemon: running`, your limits and today's token totals. (On macOS, install
triggers a Keychain prompt for `Claude Code-credentials`: allow it, or limits read
`no_credentials`; see [Troubleshooting](#troubleshooting).)

**3. Optional: pair your phone.**

```bash
claude-usage pair
```

A page opens in your browser with a QR code. Scan it with the phone (details in
[Phone and watch](#phone-and-watch-iphone-apple-watch-android)). When the phone is in, the
page says **Pairing successful** and you can close the tab.

That is it. Run `claude-usage status` any time; it also reminds you how to pair another
phone.

### Contents

- [What install changes on your machine](#what-install-changes-on-your-machine) ·
  [Undoing it](#undoing-it)
- [The hook nudge](#the-hook-nudge) · [MCP tools](#mcp-tools) · [Status line](#status-line)
- [CLI](#cli): status, tokens, sessions, pause and resume
- [Phone and watch](#phone-and-watch-iphone-apple-watch-android): get the app, pair,
  away from home, security
- [Configuration](#configuration) · [Auto-update](#auto-update) ·
  [Platform support](#platform-support)
- [Troubleshooting](#troubleshooting) · [Development](#development) · [Docs](#docs)

## Why

Claude Code tells you nothing about your rate-limit headroom until you hit it, and
`/usage` is a thing you have to remember to type. Meanwhile your token spend is sitting in
`~/.claude/projects/**.jsonl` in a form nobody reads. `claude-usage` turns both into
something a session can see mid-conversation and something you can glance at on a phone.

- **Rate limits** are account-wide, from `GET https://api.anthropic.com/api/oauth/usage`
  and from Claude Code's own status-line data. Read-only: we never refresh tokens and never
  call any other Anthropic endpoint.
- **Token spend** is per machine, aggregated from transcripts, including subagent
  transcripts (roughly a third of real token use, and not copied into the parent file).
- **Sessions**: which Claude Code processes are running, in which project and worktree,
  what they have spent, and whether they are paused.

## Install options

The [Quick start](#quick-start) is the whole install. `install` is interactive and confirms
each item; `--yes` accepts the defaults (service **on**, hook **on**, MCP **on**, status
line **off**, LAN **off**). Flags:

| Flag | Effect |
| --- | --- |
| `--yes`, `-y` | accept the defaults, no prompts (required when stdin is not a TTY) |
| `--no-service` | do not install the launchd/systemd unit |
| `--no-hook` | do not register the Claude Code hooks |
| `--no-mcp` | do not register the MCP server |
| `--statusline` | also set `statusLine` (only if you do not already have one) |
| `--lan` | add `"lan"` to `config.bind` so a phone on the same Wi-Fi can reach the daemon (an interactive install asks, default yes; `--yes` alone does not add it) |
| `--tailscale` | add `"tailscale"` to `config.bind` so the daemon listens on the tailnet |
| `--linger` | systemd only: `loginctl enable-linger` so the daemon survives logout |

Re-running `install` is safe: it refreshes the installed copy and asks each question again.

Uninstall: `claude-usage uninstall` (add `--purge` to delete config and state too).

## What install changes on your machine

| Path | What | Mode |
| --- | --- | --- |
| `~/.config/claude-usage/` | config, state, bearer token | dir `0700`, files `0600` |
| `~/.local/share/claude-usage/versions/<version>/` | a copy of the package | — |
| `~/.local/share/claude-usage/current` | symlink → the active version; the unit runs out of this | — |
| `~/.local/bin/claude-usage` | symlink → `current/bin/claude-usage`, so `claude-usage` is on your PATH (`$XDG_BIN_HOME` if set; never overwrites an existing file) | — |
| `~/Library/LaunchAgents/com.github.drmuzikbpn.claude-usage.plist` (macOS) | LaunchAgent, `RunAtLoad`, `KeepAlive: { SuccessfulExit: false }` | `0644` |
| `~/Library/Logs/claude-usage/daemon.{out,err}.log` (macOS) | daemon stdout/stderr | dir `0700` |
| `~/.config/systemd/user/claude-usage.service` (Linux) | user unit, `Restart=on-failure`, `WantedBy=default.target`; logs go to the journal | `0644` |
| `~/.claude/settings.json` | **merge-only**: four hook groups, optionally `statusLine` | mode preserved |
| `~/.claude/settings.json.claude-usage.bak` | one-time backup, written once and never overwritten | copies the source mode |
| `~/.claude.json` | `mcpServers["claude-usage"]`, written by `claude mcp add --scope user` | `0600` |

`XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_BIN_HOME` are respected; the first two are baked into the unit file.

If `~/.local/bin` is not on your PATH, `install` prints the line to add to your shell profile.

### Exact hook groups

Install **appends** one matcher-less group per event to `hooks.<Event>` in
`~/.claude/settings.json`. Existing groups are never touched.

| Event | `timeout` (seconds) | Why |
| --- | --- | --- |
| `SessionStart` | 5 | registers the session (`sessionId`, pid, cwd, transcript, git common dir) |
| `SessionEnd` | 5 | ends the session |
| `UserPromptSubmit` | 86400 | heartbeat → pause gate → limits nudge |
| `PreToolUse` | 86400 | pause gate, and records the last tool used |

```json
{ "hooks": [ { "type": "command",
               "command": "/Users/you/.local/share/claude-usage/current/bin/claude-usage hook",
               "timeout": 86400 } ] }
```

The 86400 s timeouts exist because a soft-paused session's hook *sleeps* at the boundary;
Claude Code's default 60 s would kill it and let the session run on. The hook's own HTTP
deadline is 200 ms — that is what protects your prompt latency.

### MCP registration

```json
"mcpServers": { "claude-usage": { "type": "stdio",
                                  "command": "<…>/current/bin/claude-usage",
                                  "args": ["mcp"] } }
```

Primary path is `claude mcp add --scope user claude-usage -- <abs path> mcp`, because
`~/.claude.json` is Claude Code's live state file and running sessions rewrite it. If
`claude` is not on `PATH`, install falls back to a read-merge-`rename(2)` at `0600` and
warns you to quit running sessions first. No `.bak` is written for that file — a `0644`
backup of a `0600` file would leak it.

### Undoing it

```bash
claude-usage uninstall          # unit, hooks, MCP entry and PATH link removed, config kept
claude-usage uninstall --purge  # also deletes ~/.config/claude-usage and the versions dir
```

Uninstall removes exactly the entries whose command is our resolved binary, deletes arrays
and the `hooks` object it created if they end up empty, and never touches your `.bak` or
systemd lingering. It SIGCONTs any hard-frozen processes first.

## The hook nudge

Silent while everything is `ok`. At `warn`:

```
⚠ Claude usage: 5h window 84% (resets 14:35), 7d 61%. Prefer lighter work, smaller models, avoid large file reads.
```

At `critical`:

```
🛑 Claude usage: 5h window 96% — resets in 41m. Defer non-urgent work; keep outputs short.
```

Same `(window, status)` inside the debounce window stays silent; any status *change*
prints immediately. The hook always exits 0, never exits 2, and prints nothing at all if
the daemon is unreachable or slow.

## MCP tools

Five read-mostly tools over stdio. Each returns a one-line human-readable headline
followed by the raw JSON body.

| Tool | What |
| --- | --- |
| `get_limits` | the cached rate-limit array (no network call) |
| `get_summary` | limits + per-limit `ok`/`warn`/`critical` + today's tokens — prefer this |
| `get_tokens` | token spend, `{ since?, groupBy? }` |
| `get_sessions` | live sessions: project, worktree, pid, model, tokens, pause |
| `refresh_limits` | force a refetch (at most one upstream call a minute, counting scheduled polls) |

There is deliberately **no** pause/resume/freeze tool. Controlling sessions stays with the
human.

> "Before we start this refactor, check `get_summary` — if the 5h window is over 80%, plan
> it out in one pass instead of exploring file by file."

## Status line

Prints `5h 42% · 7d 61%`, coloured amber/red above your thresholds, `⏸ paused from
dashboard · …` when the session is soft-paused, and nothing at all when the daemon is
down. If you already have a `statusLine`, install prints the snippet instead of
overwriting it:

```json
{ "statusLine": { "type": "command",
                  "command": "/Users/you/.local/share/claude-usage/current/bin/claude-usage statusline" } }
```

### Live limits from your own statusline

Anthropic's usage endpoint allows this daemon only a few calls an hour, so the headline
numbers come from Claude Code itself: it passes its statusline command a `rate_limits`
object (5-hour and 7-day utilisation, read from its own model responses). `claude-usage
statusline` forwards it automatically. If you keep your own statusline script, add one line
after it reads stdin (the example assumes it is in `$input`):

```bash
printf '%s' "$input" | ~/.local/share/claude-usage/current/bin/claude-usage observe >/dev/null 2>&1 &
```

`observe` prints nothing, always exits 0, and skips a payload identical to the one it sent
in the last 60 s. While those observations are fresh the daemon polls Anthropic at most
hourly, only for the per-model weekly and extra usage.

## CLI

```bash
$ claude-usage status
daemon: running (pid 48213, port 47291, version 0.1.0)
overall: warn
limits:
  session               84%  warn      resets 2026-09-13T23:00:00.000Z
  weekly_all            34%  ok        resets 2026-09-16T13:00:00.000Z
  weekly_scoped:fable   20%  ok        resets 2026-09-16T13:00:00.000Z
today: 1,909 messages, in 7,704 / out 534,151, cache 10,071,412 created / 192,771,920 read
```

```bash
$ claude-usage tokens --since 7d --by project
since 2026-09-06T19:01:38.189Z, grouped by project
  group                input        output      msgs
  /home/dev/alpha         16            28         3
  /home/dev/beta         100           200         1
  TOTAL                  116           228         4
```

`--by project|session|model|day`; `--since today|all|7d|24h|30m|<ISO-8601>`.

```bash
$ claude-usage sessions
  session    project        pid      state    pause      msgs  last activity
  3f1c0a52…  foo @ foo-wt2  4242     alive    hard(3)      143  2026-09-13T14:02:51.000Z
  8ad4e017…  foo            4390     alive    -             21  2026-09-13T14:01:07.000Z
rev 812
```

```bash
$ claude-usage pause all --reason "dinner"
paused all (soft) — rule r_k3m7qz4ub2ah6ptc
affected: 3f1c0a52…, 8ad4e017…

$ claude-usage pause session:3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411 --hard
$ claude-usage resume all
removed 1 rule(s); resumed 3f1c0a52…
$ claude-usage resume --all      # works even with the daemon dead — see below
```

Scopes: `all`, `project:<gitCommonDir>`, `session:<sessionId>`. **Soft** pause stops the
session at its next prompt or tool boundary (the hook sleeps and re-polls once a second).
**Hard** pause additionally `SIGSTOP`s the tool subprocesses already running below the
session — the work in flight, not the `claude` process itself, so you keep your terminal.
Whatever it would do next is stopped at the same gate soft pause uses.

> **A long hard pause costs the frozen tool call.** Claude Code's tool timeout keeps running
> while a subprocess is stopped, so a freeze outlasting it (2 minutes by default for Bash)
> kills the command that was in flight — the session survives and sees a timeout error.
> Short freezes are lossless; hold one for minutes and expect to lose the running tool.

Other subcommands: `serve [--verbose]`, `install`, `configure`, `pair`, `uninstall`, `mcp`,
`hook`, `statusline`, `observe`, `--version`, `help`.

## Phone and watch (iPhone, Apple Watch, Android)

A phone can show your limits and live sessions and pause them. It talks to the daemon over
your **Wi-Fi**, encrypted, with nothing else to install on the Mac. Tailscale is optional,
for when you are away from home.

### Get the app

- **iPhone + Apple Watch:** **Usage Deck**, in TestFlight (invite only for now; ask the
  maintainer). The watch app installs with it.
- **Android:** the **Usage Deck** dashboard, a kiosk build for a wall or desk phone. APKs are
  the `deck-` [pre-releases](https://github.com/drmuzikbpn/claude-utilization-mcp/releases)
  of this repo, and the app updates itself after that.

### Pair a phone

1. **Turn on LAN access** if you did not during install:
   `claude-usage configure lan on`. (`claude-usage status` tells you if this is needed.)
2. **Put the phone on the same Wi-Fi** as this machine (or on your tailnet, see below).
3. **Run `claude-usage pair`.** A page opens in your browser with a QR code that works
   **once** and expires in **5 minutes**.
4. **Scan it.**
   - *iPhone:* point the Camera at it and tap **Open in Usage Deck**, or scan it from the
     app's **Pair a device** screen. On the same Apple account you can also press
     **Copy link** on the page and paste it on that screen.
   - *Android deck:* scan it from the deck's pairing screen.
5. **Done.** The page swaps the QR code for **Pairing successful — it is now safe to close
   this tab**, and the command exits by itself.

Pairing another phone, or **re-pairing** one (new phone, rotated token, "needs re-pair" in
the app), is the same command. Each run makes a new code and voids the previous one.

| If… | Then |
| --- | --- |
| `claude-usage: command not found` | open a new terminal; if it still fails, add `~/.local/bin` to your PATH (install printed the line), or run `~/.local/share/claude-usage/current/bin/claude-usage pair` |
| `no HTTPS listener to pair with` | `claude-usage configure lan on`, then `claude-usage pair` again |
| the phone says the code is invalid or expired | it was already used or more than 5 minutes passed: run `claude-usage pair` again |
| the phone cannot reach the Mac | same Wi-Fi? Guest networks and some office Wi-Fi block devices from seeing each other; use Tailscale instead |
| the QR code was visible on a call or screen share | run `claude-usage pair` again; that voids the old code |

### How pairing stays safe

The QR code never contains the daemon's token. It carries the machine's addresses, its
certificate fingerprint and a **one-time code**. The phone connects over HTTPS, checks that
the certificate matches the fingerprint (so nobody on the Wi-Fi can stand in for your Mac),
and trades the code for the token. The code works once, for 5 minutes. The pairing page is
served once, from this machine only, and removes the QR code as soon as the phone is in.

Details:

- **`lan`** in `config.bind` is this machine's private Wi-Fi/Ethernet address
  (`192.168.x`, `10.x`, `172.16–31.x`; never a VM bridge or VPN tunnel). The daemon notices
  when it changes, such as moving to another network, and rebinds within 30 seconds.
  `claude-usage configure lan on|off` toggles it.
- **HTTPS.** Every non-loopback address also gets an HTTPS listener on `port + 1` (47292),
  with a self-signed certificate generated once and kept in the config directory. Apps pin
  its key fingerprint; the certificate's issuer and host name do not matter to them. Plain
  HTTP stays on every address too, for Android decks paired the legacy way.
- **`<your-mac>.local`** is accepted as a `Host`, and the pairing link offers it next to the
  IP address.
- **`/health.install`** tells the app whether the hooks, the status line and the MCP server
  are set up, so its setup check can name the fix.

### Away from home: Tailscale (optional)

```bash
claude-usage install --tailscale        # or: edit config.bind to ["127.0.0.1", "lan", "tailscale"]
```

`bind` entries are IP literals or the keywords `tailscale` and `lan`. `tailscale` resolves to
the first IPv4 interface address inside `100.64.0.0/10` (falling back to `tailscale ip -4`).
An address that cannot be found gives a warning, and the daemon keeps retrying it.
`SIGHUP` re-resolves without a restart. The tailnet address gets HTTPS too, so
`claude-usage pair` lists it as another address the phone tries when the Wi-Fi one is out
of reach. Pair once and it works both at home and away.

### Legacy pairing (older Android deck builds)

```bash
claude-usage configure pairing          # v1 pairing JSON + terminal QR
claude-usage configure pairing --json   # JSON only
```

The v1 payload carries the bearer token itself, so treat that QR like a password, and
prefer `claude-usage pair` on any deck that supports it:

```json
{ "v": 1, "name": "alans-mbp", "addr": "100.101.102.103", "port": 47291, "token": "…" }
```

### Security model in five bullets

- A 32-byte random bearer token is minted at install and stored in `config.json` (`0600`).
  `claude-usage configure rotate-token` replaces it; every paired device must re-pair.
- The one exception to "mutating requests need the token" is `POST /v1/pair`. It accepts
  only a one-time pairing code that `claude-usage pair` minted, only over HTTPS, and stops
  answering a sender after 5 failures in a minute.
- **Loopback GET/HEAD needs no token** — that is what keeps the hook, the status line and
  `curl localhost` zero-config. Everything else — every non-loopback request, every
  mutating request even from loopback — requires `Authorization: Bearer <token>`, compared
  in constant time.
- The `Host` header must name an address the daemon is actually bound to (or `localhost`,
  or the machine's MagicDNS or `.local` name); anything else is `421`. Any request carrying an `Origin`
  header is `403`. No CORS headers are ever sent. That is the anti-DNS-rebinding story.
- No endpoint ever returns a credential. The OAuth access token is read, used for one
  read-only GET and never stored, logged or serialized; `/v1/config` redacts the bearer
  token.
- Loopback is decided from the socket's remote address, never from a header.

Full threat model: [`docs/security.md`](docs/security.md). Wire format and every status
code: [`docs/api.md`](docs/api.md).

### The escape hatch

```bash
claude-usage resume --all
```

This works **with no running daemon**. It reads `sessions.json` and `pause.json` straight
off disk, `SIGCONT`s every recorded pid and clears every rule.

It exists because hard pause `SIGSTOP`s real processes. If the daemon dies — crash,
`kill -9`, a bad update — while your sessions are frozen, they stay frozen, and a stopped
process cannot ask for help. Every other safety net (SIGCONT on `SIGTERM`, on `uninstall`,
on `configure service off`, and the orphan sweep at startup) depends on the daemon being
alive to run it. This one does not. It is the reason hard freeze is a feature you can
trust rather than a footgun.

## Configuration

`~/.config/claude-usage/config.json`, mode `0600`, directory `0700`. Missing file →
defaults. Unknown keys — top level and inside every known section — survive a
load/save round-trip. An invalid value is an error naming the key.

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | `os.hostname()` | label the dashboard shows for this machine |
| `port` | `47291` | HTTP port (0–65535) |
| `bind` | `["127.0.0.1"]` | IP literals and/or the keywords `tailscale`, `lan` |
| `auth.token` | `""` | bearer token; minted by `install`, `0600` |
| `pollIntervalMs` | `300000` | limits poll interval (1 000 – 86 400 000; values under 120 000 are raised to 120 000) |
| `thresholds.warn` | `80` | percent at which a limit becomes `warn` (0–100) |
| `thresholds.critical` | `95` | percent at which a limit becomes `critical`; must be ≥ `warn` |
| `hookDebounceMinutes` | `10` | quiet window for repeated nudges (0–1440) |
| `retentionDays` | `90` | days of aggregates and dedup keys kept (1–3650) |
| `projectsDir` | `~/.claude/projects` | transcript root (leading `~` expanded) |
| `integrations.service` | `true` | what install turned on; `configure` keeps these in step |
| `integrations.hook` | `true` | |
| `integrations.mcp` | `true` | |
| `integrations.statusline` | `false` | |
| `autoUpdate.enabled` | `true` | auto-update on/off |
| `autoUpdate.intervalMs` | `600000` | release-check interval (1 000 – 86 400 000) |
| `autoUpdate.repo` | `drmuzikbpn/claude-utilization-mcp` | release source; override for forks |
| `events.maxClients` | `16` | concurrent SSE streams (1–4096) |
| `tls.port` | `null` | HTTPS port for non-loopback addresses; `null` means `port + 1` |
| `tls.loopback` | `false` | also serve HTTPS on loopback (tests and CI only) |

Scriptable edits:

```bash
claude-usage configure                              # interactive menu
claude-usage configure hook off                     # on | off
claude-usage configure thresholds --warn 75 --critical 90
claude-usage configure port 47300                   # rewrites and restarts the unit
claude-usage configure rotate-token                 # then re-pair every phone: claude-usage pair
claude-usage configure lan on                       # lan | service | hook | mcp | statusline | autoupdate
claude-usage pair                                   # pair a phone (QR page)
claude-usage configure pairing [--json]             # legacy v1 pairing for older Android decks
```

Two caveats worth knowing today: `hookDebounceMinutes` and `retentionDays` are validated
and stored but not yet read back by the hook and the spend store respectively — both use
their defaults (10 minutes, 90 days). See the deviations section of
[`docs/api.md`](docs/api.md).

## Auto-update

`claude-usage update` / `rollback`, the release pipeline and the `update` fields in
`/health` are live. `/health.update` reports `{ "state": "disabled" }` only when auto-update
is genuinely off — no `current` symlink, or `configure autoupdate off`.

- Versioning `MAJOR.MINOR.<commit-count>+<short-sha>`, computed in CI from
  `git rev-list --count HEAD` on `main`.
- Every green CI run on `main` tags `v<version>` and publishes a GitHub Release with the
  `npm pack` tarball plus `SHA256SUMS`; npm publish happens from the same job.
- The daemon checks `releases/latest` every `autoUpdate.intervalMs` (±10% jitter),
  downloads over TLS, verifies the sha256, extracts to `versions/<v>/`, smoke-tests
  `node bin/claude-usage --version` from it, atomically repoints `current` and exits 0 —
  `KeepAlive` / `Restart` brings it back. The previous two versions are kept;
  `claude-usage rollback` repoints `current` to the previous one.
- Never restarts while a session is hard-frozen (`state: "deferred"`,
  `deferredReason: "hard_frozen_sessions"`), re-checked every 30 s. Soft pauses do not defer.
- Disabled automatically when there is no `current` symlink (i.e. you did not use
  `install`), or with `claude-usage configure autoupdate off`.
- Signature verification (minisign) is a follow-up; today integrity rests on sha256 over
  TLS from the same release.
- The Android dashboard ships its APK from this same repo under `deck-<version>` tags,
  published as pre-releases so they are never `releases/latest`. The updater also skips any
  `deck-` tag outright, reporting *no update* rather than an error — an error would mask the
  next real daemon release, since `releases/latest` returns only one.

### A macOS service launchd will not restart

On some Macs the LaunchAgent is registered correctly and launchd still refuses to start it
on its own: `launchctl print` shows `pended nondemand spawn`, and `RunAtLoad` and `KeepAlive`
never fire. The daemon runs when started and auto-update restarts it, so everything works
until the process dies unattended — then it stays down.

launchd's log gives the reason as `pending spawn, domain in on-demand-only mode`, which is a
state of the `gui/<uid>` domain rather than of the service. **The cause is not yet
established and re-running `install` does not clear it** — including from the machine's own
desktop, as the console user, in an `Aqua` session, which was measured. An earlier version of
this section blamed installing over ssh; that was wrong.

To tell whether a machine is affected, test the supervisor rather than the daemon — see
[docs/smoke-test.md](docs/smoke-test.md) section 8. `kickstart` works on affected and healthy
machines alike, which is why nothing else reveals it.

## Platform support

- **macOS** — launchd; credentials from the Keychain item `Claude Code-credentials`.
- **Linux** — systemd user unit; credentials from `~/.claude/.credentials.json`.
- **Windows** — not supported yet. Install fails preflight; the credential and
  service-manager interfaces exist so it can be added without touching the daemon.

Node ≥ 20. The daemon itself has zero runtime dependencies — `@modelcontextprotocol/sdk`
and `qrcode-terminal` are loaded lazily by `mcp` and `configure pairing` only, and the
`pair` page's QR code comes from a vendored copy of the same generator.

## Troubleshooting

**The daemon is down.** `claude-usage status` prints the service state and the last 20
stderr lines when it cannot reach the daemon:

```
daemon: not running (stale daemon.json — pid 48213 is gone)
config: /Users/you/.config/claude-usage
service: launchd — stopped
log: last 20 stderr lines
  …
```

macOS logs live at `~/Library/Logs/claude-usage/daemon.err.log` (truncated at install if
over 10 MB, not rotated otherwise). Linux logs go to the journal:
`journalctl --user -u claude-usage -n 50`.

**Keychain prompt.** The first credential read raises a macOS Keychain prompt for
`Claude Code-credentials`. `install` warns you *before* triggering it. Allow it once
("Always Allow" if you would rather not see it again). Denying it is not fatal: the daemon
still runs, spend still works, and `/v1/limits` reports `error.code: "no_credentials"`.

**Port already in use.** `serve` exits 1 with `port 47291 is already in use — another
claude-usage daemon may be running`. Either stop the other one, or
`claude-usage configure port 47300` (which rewrites and restarts the unit).

**Limits say `unauthorized`.** Your OAuth token expired. Run `claude` to re-login — we
never refresh tokens. The poller backs off to one attempt per 10 minutes until a fetch
succeeds.

**Nudges never appear.** They only appear at `warn` or above, and only once per
debounce window per `(window, status)`. Check `claude-usage status` for the current
`overall`, and check that the hook groups are in `~/.claude/settings.json`.

**Pairing a phone does not work.** See the table under
[Pair a phone](#pair-a-phone).

**Sessions show `discovered: "transcript"`.** The daemon was down when they started, so
they were back-filled from their transcripts and have no trusted pid. They can be
soft-paused but not hard-frozen (`409`).

## Development

```bash
npm ci
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # tsc -p tsconfig.build.json → dist/
```

TDD per module; fixtures under `test/fixtures/` contain no credentials and no real prompt
text. lefthook runs lint + typecheck pre-commit (`npm run prepare` installs it). CI runs
lint, typecheck, test and build on `ubuntu-latest` and `macos-latest`.

What CI cannot cover — launchd, systemd, the Keychain, a real Tailscale peer, a real
`SIGSTOP`ed process tree — is the manual checklist in
[`docs/smoke-test.md`](docs/smoke-test.md).

## Docs

- [`docs/api.md`](docs/api.md) — every HTTP endpoint, status code, error envelope, the SSE
  wire format, and the known deviations between spec and code.
- [`docs/security.md`](docs/security.md) — threat model, what the token protects, file
  modes, the escape hatch, update integrity, how to report an issue.
- [`docs/smoke-test.md`](docs/smoke-test.md) — the manual checklist.
- [`CHANGELOG.md`](CHANGELOG.md).

---

Works with Claude Code. Not affiliated with, endorsed by, or sponsored by Anthropic.
Claude and Claude Code are trademarks of Anthropic.

MIT © contributors. See [`LICENSE`](LICENSE).
