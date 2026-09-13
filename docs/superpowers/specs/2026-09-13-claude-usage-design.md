# claude-usage — local usage service for Claude Code sessions

**Date:** 2026-09-13
**Status:** approved design, pre-implementation
**License target:** MIT, public GitHub repo

## 1. Purpose

A small local daemon that Claude Code sessions (and humans) can query to learn:

1. **Rate-limit utilization** for the logged-in Claude Code account — the 5-hour and
   7-day windows (percent used, reset time) that `/usage` shows. Account-wide.
2. **Local token spend** aggregated from Claude Code's transcript files — per project,
   session, model and day. Per-machine.

Sessions consume it automatically through a `UserPromptSubmit` hook (nudge when a
window crosses a threshold) and on demand through an MCP server. The hook **never
blocks** a prompt; it only informs.

## 2. Decisions made during brainstorming

| Topic | Decision |
| --- | --- |
| Datasets | Rate-limit windows **and** local token spend |
| Consumption | Hook (automatic nudge) + MCP server (on-demand detail) + optional status line |
| Runtime | Always-on daemon (launchd / systemd user unit), HTTP on localhost |
| Platforms v1 | macOS + Linux; Windows deferred behind `credentials` / `service-manager` interfaces |
| Hook behaviour | Inform only. Warn ≥ 80 %, critical ≥ 95 %, thresholds configurable. Never exit 2 |
| Install | `claude-usage install`: interactive, confirms each item, daemon defaults to **on** |
| Configure | `claude-usage configure` toggles service / hook / MCP / statusline, thresholds, port |
| Language | TypeScript on Node ≥ 20, zero runtime deps for the daemon |
| Cost estimates | Out of v1 (pricing tables rot) |

## 3. Architecture

```
┌──────────────────────────── claude-usage daemon (node:http, 127.0.0.1:47291) ────────────────────────────┐
│  credentials/  →  limits/client  →  limits/poller  ──┐                                                     │
│  (keychain | file)   (OAuth usage endpoint)          ├─→  server/  (GET /health, /v1/limits, /v1/spend,   │
│  spend/watcher → spend/scanner → spend/store ────────┘             /v1/summary, /v1/config, POST /v1/refresh)│
│  (fs.watch + sweep)  (JSONL tail)  (dedup + aggregates + state.json)                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ 200 ms              ▲ 2 s                    ▲                      ▲
   hook (UserPromptSubmit)   mcp (stdio)         statusline              status / spend CLI, curl
```

One npm package, one CLI (`claude-usage`) with subcommands:
`serve`, `install`, `uninstall`, `configure`, `status`, `spend`, `hook`, `mcp`, `statusline`.

## 4. HTTP API

Bind `127.0.0.1:<port>` (default `47291`, configurable). Localhost only, no auth —
the trust boundary is "same user on the same machine"; documented in the README.
All responses JSON. 5 s request timeout.

### `GET /health`
```json
{ "ok": true, "version": "0.1.0", "uptimeMs": 1234, "pid": 4242,
  "stats": { "filesTracked": 12, "eventsIndexed": 5400, "parseErrors": 0,
             "lastScanAt": "...", "spendReady": true } }
```

### `GET /v1/limits`
```json
{ "fetchedAt": "2026-09-13T14:00:00Z", "stale": false, "error": null,
  "windows": {
    "five_hour":     { "utilization": 42.1, "resetsAt": "2026-09-13T16:35:00Z" },
    "seven_day":     { "utilization": 61.0, "resetsAt": "2026-09-18T09:00:00Z" },
    "seven_day_opus": { "utilization": 12.0, "resetsAt": "..." }
  },
  "raw": { "...verbatim upstream payload..." } }
```
- Upstream schema is undocumented. `raw` is always served verbatim; `windows` contains
  only fields we have verified. Unknown/missing fields → `null`, never a thrown error.
- `stale: true` when serving a last-good value after a fetch failure; `error` then carries
  `{ code: "unauthorized" | "network" | "schema_drift" | "no_credentials", message, hint }`.

### `GET /v1/spend?since=<iso|7d|24h|today>&groupBy=project|session|model|day`
```json
{ "ready": true, "since": "...", "groupBy": "project",
  "totals": { "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0, "messages": 0 },
  "groups": [ { "key": "/Users/me/code/foo", "input": 0, "output": 0,
                "cacheCreate": 0, "cacheRead": 0, "messages": 0 } ] }
```
`ready: false` (with empty totals) until the initial scan completes. Default
`since=today`, `groupBy=project`. Multiple `groupBy` values are not supported in v1.

### `GET /v1/summary`
The hook's single call. Small payload:
```json
{ "limits": { "...as /v1/limits minus raw..." },
  "status": { "five_hour": "ok|warn|critical", "seven_day": "ok", "overall": "warn" },
  "thresholds": { "warn": 80, "critical": 95 },
  "today": { "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0, "messages": 0 } }
```

### `POST /v1/refresh`
Forces a limits refetch. Rate-limited to one per 10 s (`429` otherwise). Returns the
new `/v1/limits` body.

### `GET /v1/config`
Effective config: thresholds, port, poll interval, resolved paths, enabled integrations.

## 5. Data sources

### 5.1 Credentials (`src/credentials/`)
Interface: `getAccessToken(): Promise<string>`; throws `NoCredentialsError`.
- **macOS** `keychain.ts`: `security find-generic-password -s "Claude Code-credentials" -w`,
  parse JSON, read `claudeAiOauth.accessToken`. First access may show a Keychain prompt;
  `install` warns before triggering it.
- **Linux** `file.ts`: `~/.claude/.credentials.json`, same JSON shape.
- Selected by `process.platform` at startup. Windows → `UnsupportedPlatformError`.
- **We never refresh tokens.** Claude Code owns refresh. On `401` we re-read credentials
  once and retry; if still `401`, surface `unauthorized` with hint "run `claude` to re-login".

### 5.2 Rate limits (`src/limits/`)
- `client.ts`: `fetchLimits(token): Promise<LimitsPayload>` → `GET https://api.anthropic.com/api/oauth/usage`
  with `Authorization: Bearer <token>` and the OAuth beta header Claude Code sends.
  **The exact response shape is verified in the first implementation step** (read-only
  GET with the live token) and captured as a redacted fixture; normalization is written
  against that fixture.
- `poller.ts`: fetch every `pollIntervalMs` (default 60 000). On failure: exponential
  backoff (2× from 60 s, cap 10 min), keep serving last-good with `stale: true`.

### 5.3 Token spend (`src/spend/`)
- Source: `~/.claude/projects/<encoded-cwd>/*.jsonl`. Lines with `type === "assistant"` →
  `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`,
  `message.model`, `message.id`, `requestId`, `timestamp`, `sessionId`, `cwd`.
- **Dedup key** `message.id + ":" + requestId`. Streaming appends the same assistant
  message several times; counting each would double-count (the classic bug).
- `scanner.ts`: per file, resume from stored byte offset; if offset > file size (truncated /
  rotated) restart from 0 and drop that file's events. Malformed line → skip, `parseErrors++`.
- `watcher.ts`: `fs.watch(projectsDir, { recursive: true })`, 500 ms debounce → scan; plus a
  5-minute safety sweep (recursive watch is unreliable on some Linux setups).
- `store.ts`: aggregates keyed by `(day, project, sessionId, model)`; dedup set; answers
  `/v1/spend`. Retention 90 days (aggregates and dedup entries pruned together).
  Snapshot to `state.json` every 30 s and on shutdown: `{ version, offsets: {file: bytes},
  aggregates, dedup }`. Snapshot version mismatch → full rescan.

## 6. Daemon lifecycle (`src/daemon.ts`)
- Startup order: load config → load `state.json` → start HTTP (so `/v1/limits` is available
  immediately) → start poller → initial spend scan (`ready: false` until done) → start watcher.
- Writes `~/.config/claude-usage/daemon.json` `{ pid, port, startedAt, version }` on start;
  clients read it to discover the port. Removed on clean shutdown; `status` detects a
  stale file (pid not alive).
- `SIGTERM`/`SIGINT` → flush snapshot, remove `daemon.json`, exit 0.
- Port in use → exit 1 with a clear message.
- Logs to stderr only (launchd/systemd capture). `--verbose` for debug lines.

## 7. Integrations

### 7.1 Hook — `claude-usage hook`
- Registered as a `UserPromptSubmit` hook in `~/.claude/settings.json`.
- Reads and ignores stdin. `GET /v1/summary`, **200 ms** timeout.
- Any failure → exit 0, no output. The hook must never slow or break a session.
- `overall === "ok"` → no output.
- `warn`: `⚠ Claude usage: 5h window 84% (resets 14:35), 7d 61%. Prefer lighter work, smaller models, avoid large file reads.`
- `critical`: `🛑 Claude usage: 5h window 96% — resets in 41m. Defer non-urgent work; keep outputs short.`
- Debounce: if the same `(window, status)` was printed within `hookDebounceMinutes`
  (default 10), stay silent. Any status **change** prints immediately. State kept in
  `~/.config/claude-usage/hook-state.json`.
- Always exit 0. Never exit 2.

### 7.2 MCP server — `claude-usage mcp`
- stdio transport via `@modelcontextprotocol/sdk` (the only runtime dependency, loaded
  lazily so the daemon never imports it).
- Tools: `get_limits`, `get_spend { since?, groupBy? }`, `get_summary`, `refresh_limits`.
- Thin HTTP proxies, 2 s timeout. Daemon down → tool error text
  `"claude-usage daemon not running — run `claude-usage status`"`.
- Registered in `~/.claude.json` → `mcpServers["claude-usage"] = { command: "claude-usage", args: ["mcp"] }`.

### 7.3 Status line — `claude-usage statusline` (optional, default off)
- Prints `5h 42% · 7d 61%`; ANSI colour above warn/critical. Daemon down → prints nothing.
- Install sets `statusLine.command` only when none exists; otherwise prints the snippet
  for the user to append to their own script.

### 7.4 Human CLI
- `claude-usage status` — daemon state, limits table, today's spend, integration toggles.
- `claude-usage spend --since 7d --by project|session|model|day` — table output.

## 8. Install / configure / uninstall

### `claude-usage install [--yes] [--no-service] [--no-hook] [--no-mcp] [--statusline]`
1. **Preflight:** Node ≥ 20, supported platform, credentials readable (warn about the
   Keychain prompt first). Fail early with actionable messages.
2. **Plan + confirm** each item (defaults: service **yes**, hook yes, MCP yes, statusline no).
   `--yes` accepts defaults.
3. **Apply:**
   - Service: macOS `~/Library/LaunchAgents/com.claude-usage.plist` (`KeepAlive`, `RunAtLoad`,
     `launchctl bootstrap gui/$UID`); Linux `~/.config/systemd/user/claude-usage.service`
     (`Restart=always`, `systemctl --user enable --now`).
   - Hook / MCP / statusline: **merge-only** JSON edits to `~/.claude/settings.json` and
     `~/.claude.json`: parse → add our entries → write. Unrelated keys untouched, key order
     preserved where JSON allows, `.bak` written first, idempotent on re-run. Malformed
     JSON → abort with the path; never overwrite.
4. **Verify:** `GET /health` (retry up to 5 s), print the status table.

### `claude-usage configure`
- No args → interactive menu: service / hook / MCP / statusline on–off, thresholds,
  port, poll interval, hook debounce.
- Scriptable: `configure service off`, `configure hook on`, `configure thresholds --warn 75 --critical 90`, …
- Turning a thing off removes exactly what install added (unit file unloaded + deleted;
  our hook/MCP entries removed; other entries untouched).
- Port change → rewrite unit file and restart service if enabled.

### `claude-usage uninstall [--purge]`
Reverses all install steps; keeps `~/.config/claude-usage/` unless `--purge`.

### Service manager interface (`src/service/`)
`install(unit) / uninstall() / start() / stop() / status()` with `launchd.ts` and
`systemd.ts` implementations; a `noop` implementation for `--no-service`.

## 9. Configuration file
`~/.config/claude-usage/config.json` (XDG; `$XDG_CONFIG_HOME` respected):
```json
{ "port": 47291, "pollIntervalMs": 60000,
  "thresholds": { "warn": 80, "critical": 95 },
  "hookDebounceMinutes": 10, "retentionDays": 90,
  "projectsDir": "~/.claude/projects",
  "integrations": { "service": true, "hook": true, "mcp": true, "statusline": false } }
```
Missing file → defaults. Unknown keys preserved. Invalid values → error naming the key.

## 10. Error handling principles
- The daemon never crashes on bad data: skip and count.
- Missing credentials → daemon still runs; `/v1/limits` returns `error.code = "no_credentials"`;
  spend unaffected.
- Every client (hook, MCP, statusline) treats every failure as "no information".
- Schema drift upstream → `raw` still served, normalized fields `null`, `stale: true`,
  `error.code = "schema_drift"`.

## 11. Testing strategy (vitest, TDD per module)
- `credentials`: fakes for keychain/file; parse fixtures incl. missing key.
- `limits/client`: fixture payloads (captured live once, redacted) for ok / 401 / schema
  drift / network error; retry-once-on-401 behaviour.
- `limits/poller`: fake timers — interval, backoff, last-good + stale.
- `spend/scanner`: fixture JSONL dir — dedup, offset resume, truncation restart,
  malformed lines, mixed models, non-assistant lines ignored.
- `spend/store`: each `groupBy`, `since` filters, retention pruning, snapshot round-trip,
  version-mismatch rescan.
- `server`: listen on port 0, `fetch` every route incl. 404/405, `ready:false` path,
  refresh rate limit.
- `hook`: fake daemon on port 0 → exact stdout for ok / warn / critical / debounced /
  status-change / unreachable / timeout; exit code always 0.
- `install`: settings merge against fixtures — untouched keys preserved, idempotent,
  malformed → abort, `.bak` written; service-manager and keychain exercised through fakes.
- Manual smoke checklist in `docs/smoke-test.md` for real launchd/systemd/Keychain.
- CI: GitHub Actions on `macos-latest` + `ubuntu-latest`: lint, typecheck, test.

## 12. Repository layout
```
bin/claude-usage           # node shim → dist/cli.js
src/cli.ts                 # subcommand dispatch
src/daemon.ts
src/config.ts
src/credentials/{index,keychain,file}.ts
src/limits/{client,poller,types}.ts
src/spend/{scanner,watcher,store,types}.ts
src/server/{index,routes}.ts
src/clients/http.ts        # shared thin client (timeouts, daemon.json discovery)
src/hook.ts  src/mcp.ts  src/statusline.ts
src/install/{index,settings-merge,plan}.ts
src/service/{index,launchd,systemd,noop}.ts
test/…  test/fixtures/…
docs/smoke-test.md  docs/api.md
CLAUDE.md  README.md  LICENSE  lefthook.yml  .github/workflows/ci.yml
```
Tooling: TypeScript strict, ESM, vitest, eslint, lefthook (lint + `tsc --noEmit` pre-commit),
`.gitignore` includes `*.tsbuildinfo`.

## 13. Out of scope for v1
Windows; cost estimates; cross-machine spend aggregation; authentication on the HTTP API;
token refresh; any write to Anthropic APIs.

## 14. Open item to resolve first in implementation
Verify the OAuth usage endpoint response shape with a live read-only GET; capture a
redacted fixture; adjust §4 `windows` normalization to the verified field names.

---

# Part II — remote dashboard scope (approved 2026-09-13)

Added after the Android kiosk dashboard ("Jamie" session, repo `../android-project`) was
scoped. The dashboard consumes this daemon over Tailscale from a Nexus 5X, aggregates two
daemons (Alan + teammate) itself, and needs to see and pause live sessions. Sections 15–21
extend Part I; where they conflict, Part II wins. Implementation order: core daemon (Part I)
→ sessions/pause → events → network/auth → auto-update.

## 15. Identity & host metadata

`GET /health` gains:
```json
{ "name": "alans-mbp", "version": "0.1.417+3f9c2ab",
  "user": { "emailAddress": "…", "accountUuid": "…", "organizationUuid": "…", "displayName": "…" },
  "update": { "channel": "stable", "current": "0.1.417+3f9c2ab", "available": null,
              "state": "idle|checking|downloading|verifying|ready|deferred|disabled",
              "deferredReason": null } }
```
- `user` is read from `~/.claude.json → oauthAccount` (verified keys: `emailAddress`,
  `accountUuid`, `organizationUuid`, `displayName`, `organizationName`). Missing file/keys →
  `user: null`. Re-read every 10 min (the account can change on re-login).
- `name` defaults to `os.hostname()`, overridable in config.

## 16. Network binding & authentication

**Binding.** `config.bind` is a list, default `["127.0.0.1"]`; `install` offers to add
`"tailscale"`. Each entry is an IP literal or the keyword `tailscale`, resolved at startup to
the first IPv4 interface address inside `100.64.0.0/10` (falls back to `tailscale ip -4` if the
CLI exists). No Tailscale interface → log a warning, bind the rest. One `http.Server` per
address, same handler. Re-resolve on `SIGHUP`.

**Auth model.** Threat model: anything on the tailnet, plus any process/browser on the local
machine (DNS rebinding, `localhost` fetches from web pages).
- A 32-byte random **bearer token** is generated at install, stored in `config.json`
  (`auth.token`, file mode `0600`). `claude-usage configure rotate-token` regenerates it.
- **Loopback + safe method (GET/HEAD) → no token required.** Keeps hook, statusline and
  `curl localhost` zero-config. `/v1/events` from loopback is also exempt.
- **Everything else requires `Authorization: Bearer <token>`** — every non-loopback request
  and every mutating request (POST/DELETE) regardless of source. Missing/wrong → `401`
  `{ error: { code: "unauthorized" } }`, constant-time compare.
- **Host allowlist:** `Host` must be one of the bound addresses (with port), `localhost`, or
  the machine's Tailscale MagicDNS name (from `tailscale status --json`, if available);
  otherwise `421`. No CORS headers are ever sent (browsers can't read responses).
- Loopback is determined from the socket's remote address, never from headers.

**Pairing.** `claude-usage configure pairing` prints
`{ "v": 1, "name": "alans-mbp", "addr": "100.68.121.23", "port": 47291, "token": "…" }`
as JSON and as a terminal QR code (single small dependency for QR rendering, CLI-only —
the daemon never loads it). `--json` suppresses the QR.

## 17. Sessions

### 17.1 Discovery — via our own hooks, not process scraping
| Hook event | Action |
| --- | --- |
| `SessionStart` | `POST /v1/sessions/register` `{ sessionId, pid, cwd, transcriptPath, gitCommonDir, source }` — `pid` = the hook process's `ppid` (the `claude` process); `gitCommonDir` = `git rev-parse --git-common-dir` resolved to an absolute path, run once in `cwd` (null if not a repo). |
| `UserPromptSubmit` | heartbeat (`lastActivityAt`) + soft-pause gate (§18) + limits nudge (§7.1). |
| `PreToolUse` | soft-pause gate only (§18). |
| `SessionEnd` | `POST /v1/sessions/{id}/end`. |
Registration is idempotent (`claude --resume` re-registers the same `sessionId` with a new
pid). `install` adds all four hook entries; `configure hook off` removes them together.

### 17.2 Liveness & reconciliation
- Every 15 s the daemon `kill(pid, 0)`s each registered pid; dead → mark `alive: false`,
  drop after 5 min (so the dashboard sees the exit).
- Sessions the hooks never saw (daemon was down at their start) are back-filled from the spend
  scanner: a `sessionId` with a fresh assistant message but no registration appears with
  `pid: null`, `discovered: "transcript"`. Hard pause is refused (`409`) for those.
- `model`, `tokens` (input/output/cacheCreate/cacheRead/messages) and `startedAt` come from
  the spend store, keyed by `sessionId`.

### 17.3 `GET /v1/sessions`
```json
{ "rev": 812, "sessions": [ {
  "sessionId": "…", "pid": 4242, "alive": true, "discovered": "hook",
  "cwd": "/Users/alan/code/foo-wt2", "transcriptPath": "…",
  "project": { "gitCommonDir": "/Users/alan/code/foo/.git", "name": "foo" },
  "worktree": "foo-wt2",
  "model": "claude-opus-5", "startedAt": "…", "lastActivityAt": "…",
  "tokens": { "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0, "messages": 0 },
  "pause": null
} ] }
```
- `rev` is a monotonic counter bumped on any sessions/pause change; sent as `ETag: W/"812"`,
  `If-None-Match` → `304`.
- `project.name` = basename of the main worktree (parent of `gitCommonDir`); `worktree` =
  basename of `cwd` when it differs from the main worktree, else `null`. Sessions with
  `gitCommonDir: null` group under `project: { gitCommonDir: null, name: <basename(cwd)> }`.
- `pause` when paused: `{ "mode": "soft|hard", "ruleId": "…", "scope": "…", "since": "…",
  "frozenPids": [4242, 4251] }`.

## 18. Pause & resume

### 18.1 Rules, not flags
```json
{ "id": "r_01H…", "scope": "all" | "project:<gitCommonDir>" | "session:<sessionId>",
  "mode": "soft" | "hard", "reason": "…", "createdAt": "…", "createdBy": "dashboard|cli" }
```
- Rules are persisted in `state.json` and survive daemon restarts.
- A session's **effective** pause = most specific matching rule (session > project > all);
  `hard` beats `soft` at the same specificity. Rules apply to sessions that register **after**
  the rule was created (a new worktree session in a paused project comes up paused).
- Same `(scope, mode)` posted twice → `200` with the existing rule (idempotent).

### 18.2 Soft pause (stop at the next boundary)
- `UserPromptSubmit` and `PreToolUse` hooks call `GET /v1/sessions/{id}/gate` →
  `{ "paused": true, "mode": "soft", "ruleId": "…", "reason": "…" }`. While `paused`, the hook
  sleeps and re-polls every 1 s (loopback GET, no token). When cleared it exits 0 and the
  session continues. Daemon unreachable → not paused (fail open, never wedge a session).
- Hook entries are installed with `"timeout": 86400` (Claude Code's default 60 s would kill
  the sleeping hook and let the session continue).
- While soft-paused the hook writes `~/.config/claude-usage/paused/<sessionId>` so the
  statusline can show `⏸ paused from dashboard`; removed on resume.

### 18.3 Hard freeze (SIGSTOP)
- Resolve `pid` → the full descendant tree (`ps -axo pid=,ppid=` walk; Linux may use
  `/proc/*/stat`), `SIGSTOP` children first then the parent; record `frozenPids` on the session.
- Resume → `SIGCONT` parent first then children; ignore `ESRCH`.
- **Safety invariants**
  - Clean shutdown (`SIGTERM`), `uninstall`, and `configure service off` → `SIGCONT`
    every recorded `frozenPids` first.
  - Startup → for every persisted hard rule, re-resolve pids and re-freeze **only** if the
    session is still alive; any `frozenPids` recorded in state whose session no longer
    matches a rule are `SIGCONT`ed (orphan sweep).
  - `claude-usage resume --all` works **without a running daemon**: reads `state.json`,
    `SIGCONT`s everything recorded, clears the rules. This is the documented escape hatch.
  - Hard freeze is refused (`409`) for `discovered: "transcript"` sessions (no trusted pid) and
    for pids not owned by the daemon's uid.
- A hard request for a `session:<id>` whose pid is gone → rule not created, `410`.

### 18.4 Endpoints (all mutating → token required)
| Method & path | Body → response |
| --- | --- |
| `POST /v1/pause` | `{ scope, mode, reason? }` → `200 { rule, affected: [sessionId…] }`; `409` untrusted pid; `410` dead session |
| `POST /v1/resume` | `{ scope }` → `200 { removed: [ruleId…], resumed: [sessionId…] }` (empty arrays if nothing matched — idempotent) |
| `GET /v1/pause/rules` | `{ rev, rules: […] }` |
| `DELETE /v1/pause/rules/{id}` | `204`; `404` unknown |
| `POST /v1/sessions/{id}/pause` | `{ mode, reason? }` — sugar for `scope: "session:<id>"` |
| `POST /v1/sessions/{id}/resume` | sugar for `scope: "session:<id>"` |
| `GET /v1/sessions/{id}/gate` | `{ paused, mode, ruleId, reason }` — loopback, polled by hooks |
CLI mirrors: `claude-usage sessions`, `claude-usage pause <all|project:<path>|session:<id>> [--hard]`,
`claude-usage resume <scope>|--all`.

## 19. Events — `GET /v1/events` (SSE)
- `text/event-stream`, `id:` = current `rev`, `retry: 3000`.
- On connect (and on any reconnect, regardless of `Last-Event-ID` — simplest correct
  behaviour): one `snapshot` event `{ name, version, user, limits, summary, sessions, rules, update, rev }`
  (`name`/`version`/`user` as in `/health`, so a client can label the machine without a second call).
- Then: `limits` (each successful poll where anything changed), `spend` (`{ today, delta }`,
  coalesced to ≤ 1/s), `session` (`{ type: "start|end|update", session }`), `pause`
  (`{ rules, affected }`), `update` (`/health.update` object), `heartbeat` every 15 s.
- Back-pressure: if a client's socket buffer is full for > 30 s, close it (it reconnects and
  gets a snapshot). Max 16 concurrent SSE clients.
- No WebSocket in v1 (would require a dependency; SSE is one-directional and sufficient).
- Polling fallback documented for clients: `/v1/summary` + `/v1/sessions` (with
  `If-None-Match`) at ≥ 2 s intervals.

## 20. Auto-update
- **Versioning:** `MAJOR.MINOR.<commit-count>+<short-sha>` computed in CI from
  `git rev-list --count HEAD` on `main` — monotonic, commit-stamped, valid semver.
- **Release:** every green CI run on `main` tags `v<version>` and publishes a GitHub Release
  with `claude-usage-<version>.tgz` (the `npm pack` output) and `SHA256SUMS`. npm publish
  happens from the same job; the tarball on GitHub is what the updater consumes.
- **Layout:** `~/.local/share/claude-usage/versions/<version>/` + `current` symlink. The
  launchd/systemd unit runs `<XDG_DATA_HOME>/claude-usage/current/bin/claude-usage serve`.
  `install` copies the running package into this layout first, whether it came from npm or a
  tarball — after install, the install method no longer matters.
- **Loop:** every `autoUpdate.intervalMs` (default 10 min, jittered ±10 %) `GET
  https://api.github.com/repos/<owner>/<repo>/releases/latest` (repo pinned in code, overridable
  in config for forks). Newer → download tarball + `SHA256SUMS` to a temp dir, verify sha256,
  extract into `versions/<v>/`, run `node bin/claude-usage --version` from it as a smoke test,
  atomically repoint `current`, then `process.exit(0)` → `KeepAlive`/`Restart=always` relaunches.
  Keeps the previous 2 versions; `claude-usage rollback` repoints `current` to the previous one.
- **Deferral:** never restart while any session has a hard freeze (`state: "deferred"`,
  `deferredReason: "hard_frozen_sessions"`); re-check every 30 s. Soft pauses don't defer.
- **Off switch:** `autoUpdate.enabled=false` (`configure autoupdate off`); when the daemon
  wasn't installed via `install` (no `current` symlink) the updater is disabled automatically.
- **Integrity:** sha256 from `SHA256SUMS` on the same release; download over TLS only; a
  failed verify deletes the download and reports `update.state: "error"`. Signature
  verification (minisign) is a follow-up, tracked in the README.

## 21. Config additions
```json
{ "name": "alans-mbp",
  "bind": ["127.0.0.1", "tailscale"],
  "auth": { "token": "…" },
  "autoUpdate": { "enabled": true, "intervalMs": 600000, "repo": "<owner>/claude-utilization-mcp" },
  "events": { "maxClients": 16 } }
```
`config.json` is written with mode `0600` because it now holds the token.

## 22. Testing additions
- `sessions`: register/heartbeat/end fixtures; liveness marking; transcript back-fill; worktree
  grouping from `gitCommonDir` (fixtures with two worktrees of one repo); `rev`/ETag/304.
- `pause`: rule specificity resolution; later-registering sessions inherit rules; idempotent
  POSTs; 409/410 paths; gate polling in the hook (fake daemon, fake timers); hard freeze against
  a spawned child process tree (`sleep` processes) — asserts `T` state via `ps`, SIGCONT on
  resume, on shutdown, and via `resume --all` with no daemon; orphan sweep on startup.
- `auth`: loopback GET exempt, loopback POST requires token, non-loopback GET requires token,
  wrong token 401 in constant time, Host allowlist 421.
- `events`: snapshot on connect, event ordering, coalescing, heartbeat, slow-client eviction.
- `update`: fake release server (port 0) — version compare, sha mismatch → error and cleanup,
  smoke-test failure → no repoint, deferral while hard-frozen, rollback.
- CI can't run launchd/systemd/Tailscale; those stay in `docs/smoke-test.md`.
