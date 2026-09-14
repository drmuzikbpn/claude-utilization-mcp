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

Bind and auth are defined in **§16** (Part II). Even loopback-only deployments enforce the Host allowlist and Origin rejection from §16.
All responses JSON. 5 s request timeout.

### `GET /health`
```json
{ "ok": true, "version": "0.1.0", "uptimeMs": 1234, "pid": 4242,
  "stats": { "filesTracked": 12, "eventsIndexed": 5400, "parseErrors": 0,
             "lastScanAt": "...", "spendReady": true } }
```

### `GET /v1/limits`
> **Superseded by §23.3** (normalize on upstream `limits[]`). Kept for history.

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
> **Amended by §23.4–23.8** (recursive walk incl. subagent transcripts, line filters, project key, memory bounds, truncation).

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
`{ "v": 1, "name": "alans-mbp", "addr": "100.101.102.103", "port": 47291, "token": "…" }`
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
> **Superseded in part by §23.16:** the session's own `claude` process is no longer
> `SIGSTOP`ed — only the tool subprocesses below it are.

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
  https://api.github.com/repos/drmuzikbpn/claude-utilization-mcp/releases/latest` (repo pinned in code, overridable
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
  "autoUpdate": { "enabled": true, "intervalMs": 600000, "repo": "drmuzikbpn/claude-utilization-mcp" },
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

---

# Part III — Part I amendments from the 2026-09-13 audit

15 findings survived a 3-vote adversarial review (56 unique candidates). Where Part I
conflicts with this section, this section wins.

## 23.1 Name & trademark
- `claude-usage` is **taken on npm** (unrelated package, v1.1.0). Publish **scoped**:
  `@drmuzikbpn/claude-usage`, `bin` stays `claude-usage`. The
  CLI name, MCP key, config dir `~/.config/claude-usage/`, launchd label
  `com.github.drmuzikbpn.claude-usage` and systemd unit `claude-usage.service` all keep `claude-usage`.
- README footer: "Works with Claude Code. Not affiliated with, endorsed by, or sponsored by
  Anthropic. Claude and Claude Code are trademarks of Anthropic."

## 23.2 Local trust boundary (supersedes §4 preamble, §13 "authentication")
- §16 applies to **all** deployments, including loopback-only: Host allowlist (`421`), any
  request carrying an `Origin` header → `403`, no CORS headers, token required for every
  mutating request. Impact being defended: local path/session-id disclosure and
  attacker-forced upstream fetches — no endpoint ever returns credentials.
- File modes: `config.json`, `state.json`, `daemon.json`, `hook-state.json` all `0600`; config
  dir `0700`.

## 23.3 Limits normalization (supersedes §4 `/v1/limits` and the `limits` part of `/v1/summary`)
```json
{ "fetchedAt": "…", "stale": false, "error": null,
  "limits": [
    { "id": "session",             "kind": "session",       "group": "session", "percent": 5,
      "severity": "normal", "resetsAt": "2026-09-13T18:00:00Z", "scope": null, "isActive": false },
    { "id": "weekly_all",          "kind": "weekly_all",    "group": "weekly",  "percent": 13, "…": "…" },
    { "id": "weekly_scoped:fable", "kind": "weekly_scoped", "group": "weekly",  "percent": 10,
      "scope": { "model": "Fable", "surface": null }, "…": "…" } ],
  "legacyWindows": { "five_hour": { "utilization": 5.0, "resetsAt": "…" }, "seven_day": { "…": "…" } },
  "extraUsage": { "isEnabled": false, "utilization": null, "spendLimitReached": true },
  "raw": { "…": "…" } }
```
- `limits[]` is normalized **1:1 from upstream `limits[]`** — the only authoritative model.
  `id` = `kind` + (`:` + lower-cased `scope.model.display_name` when present).
- `percent` is the upstream integer; thresholds are evaluated on `percent` only (the float
  `utilization` in the legacy windows may differ by rounding).
- `resetsAt` normalized through `Date` to ISO-8601 `Z`; **may be `null`** — every hook /
  statusline template must render without it ("resets: unknown").
- Status per limit = `critical` if `percent ≥ critical` **or** upstream `severity` is a
  critical-like value; `warn` if `percent ≥ warn` **or** `severity !== "normal"`; else `ok`.
  `/v1/summary.status = { byId: { "<id>": "ok|warn|critical" }, overall }`. Unknown
  `severity` strings are passed through, never thrown on.
- `legacyWindows` is best-effort passthrough of `five_hour`/`seven_day` only; `seven_day_opus`
  et al. are **not** promised. Unknown top-level keys are ignored; `raw` keeps everything.
- `/v1/spend` is renamed **`/v1/tokens`** to avoid colliding with upstream's `spend` (dollar)
  object, which we surface as `extraUsage`/`raw` only. MCP tool becomes `get_tokens`.
- Beta header is literally `anthropic-beta: oauth-2025-04-20` (see fixture README).
- On `401`: re-read credentials once, retry; still `401` → `error.code = "unauthorized"`,
  poll interval backs off to 10 min until a fetch succeeds (no hammering an expired token).

## 23.4 Transcript discovery (amends §5.3 source)
- Walk **every `*.jsonl` under `~/.claude/projects/` recursively at any depth**. Observed shapes:
  `<encoded-cwd>/<sessionId>.jsonl` (main thread) and
  `<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl` (subagent transcripts, `isSidechain: true`,
  `agentId` present — **~31 % of all tokens on the reference machine**; they are not copied into
  the parent transcript and must be counted). Non-transcript `.jsonl` files exist in the tree
  (e.g. `<project>/vercel-plugin/skill-injections.jsonl`) — lines that are not counted assistant
  lines are skipped silently, **not** counted as `parseErrors`.
- Subagent lines carry the parent's `sessionId` → tokens roll up to the session.

## 23.5 Line filter & dedup key (amends §5.3)
A line is counted iff `type === "assistant"` **and** `message.model !== "<synthetic>"` **and**
`isApiErrorMessage !== true` **and** `message.usage` is an object. Dedup key =
`message.id + ":" + (requestId ?? "")` — `requestId` is absent on some lines and the key must
never be built from `undefined`. Duplicates are per-content-block lines sharing one
`message.id`/`requestId` with identical usage; count once.

## 23.6 Project key (amends §4 `groupBy=project`, §5.3)
`project` = the `~/.claude/projects/<dir>` directory name the transcript lives under, used
verbatim as an opaque key (the encoding is lossy — `/` and `-` both become `-` — so it is
never decoded). Display label = `cwd` of the **first** counted line of the session's top-level
transcript; per-line `cwd` drifts when subagents run elsewhere and is **not** a key.
`/v1/tokens` groups carry `{ key, label }`. Part II's `gitCommonDir` grouping (§17) is a
separate, richer identity available only for hook-registered sessions.

## 23.7 Memory & time budget (amends §5.3 scanner/store, §6)
- Reference corpus: **492 MB, 355 files, largest transcript 130 MB, ~29 k dedup keys.**
- Scanner reads via `fs.open` + positional reads in **1 MB chunks** with a carry-over partial
  line; a file is never materialized whole; peak memory O(chunk). Yields to the event loop
  between chunks (`setImmediate`) so HTTP stays responsive; initial scan runs ≤ 4 files in
  flight; `/health.stats` reports `scan: { filesDone, filesTotal, bytesDone, bytesTotal }`.
- Snapshot only when dirty; dedup keys stored as a compact array of strings; state file is
  written atomically (temp + rename). Snapshot `version` mismatch → **background** rescan while
  the old aggregates keep serving (`stale: true` on `/v1/tokens` meanwhile), not a cold start.
- Watcher starts **before** the initial scan; events arriving mid-scan queue and are drained
  after it, so appends during the scan don't wait for the 5-min sweep.

## 23.8 Truncation (amends §5.3)
If a stored offset exceeds the file's current size, the file was truncated or replaced:
restart it from 0 **and schedule a full background rescan** — aggregates are pre-summed
counters not attributable to one file, so no per-file rollback is attempted.

## 23.9 launchd / systemd details (amends §6 logging, §8 service)
- launchd does **not** capture stderr by default. Plist sets `StandardOutPath` /
  `StandardErrorPath` to `~/Library/Logs/claude-usage/daemon.{out,err}.log` (dir created
  `0700`), `ProgramArguments` with the **absolute resolved node binary** (nvm/volta/fnm paths
  are not on launchd's PATH), `EnvironmentVariables.PATH` = the install-time PATH,
  `RunAtLoad`, `KeepAlive: { SuccessfulExit: false }` — so `process.exit(0)` from the
  auto-updater/`configure service off` is honoured. Logs are truncated at install when > 10 MB;
  no rotation otherwise (documented). `status` prints the last 20 stderr lines when the daemon
  is down.
- systemd user unit: absolute `ExecStart`, `Environment=PATH=…`, `Restart=on-failure`,
  `[Install] WantedBy=default.target`, `daemon-reload` after writing. Logs go to the journal
  (no file paths). The unit lives for the login session; `install --linger` runs
  `loginctl enable-linger` and reports (not fails) if unavailable. Uninstall never touches linger.

## 23.10 `~/.claude.json` is Claude Code's live state file (amends §7.2, §8 step 3)
- It is `0600` and rewritten by running Claude Code sessions. **Primary path:** delegate the
  write — `claude mcp add --scope user claude-usage -- <abs path>/claude-usage mcp`
  (and `claude mcp remove --scope user claude-usage` on uninstall).
- **Fallback** (no `claude` on PATH): re-read → merge → write a `0600` temp file in the same
  directory → `rename(2)`; **no `.bak`** for this file (a `.bak` would leak `0600` content at
  `0644`); warn the user to quit running sessions first. Entry includes `"type": "stdio"`.
- `~/.claude/settings.json` keeps the Part I protocol; its `.bak` is written **once**
  (`settings.json.claude-usage.bak`, never overwritten on re-run) and copies the source mode.

## 23.11 Hook registration shape (amends §7.1, §8)
`hooks.<Event>` is an array of matcher-groups. Install **appends** one group per event with no
`matcher` key: `{ "hooks": [ { "type": "command", "command": "<abs path>/claude-usage hook",
"timeout": <seconds> } ] }` — `timeout` is **seconds**; `5` for `SessionStart`/`SessionEnd`,
`86400` for `UserPromptSubmit`/`PreToolUse` (the soft-pause gate, §18.2). §7.1's 200 ms is the
hook's own internal HTTP deadline. Idempotency/uninstall key on the command string matching
our resolved binary path. Install fixture must include a `settings.json` that already has
several groups per event (Alan's has `PreToolUse`, `PostToolUse`, `SessionStart` populated and
a custom `statusLine` — §7.3's "print the snippet" path is the normal case, not the edge).
`statusLine` when we do set it: `{ "type": "command", "command": "<abs path>/claude-usage statusline" }`.

## 23.12 Additional tests (amends §11)
`spend/watcher` (debounce coalescing, sweep catches missed file, mid-scan queueing);
`daemon` (temp `XDG_CONFIG_HOME`, startup order, `daemon.json` lifecycle, stale pid, port in
use → exit 1, SIGCONT-on-shutdown); `config` (defaults, unknown-key round-trip, invalid value
names key, modes); `mcp` (each tool, daemon-down text, stdout reserved for JSON-RPC);
`statusline` (ok/warn/critical/paused/unreachable, `resetsAt: null`); **`uninstall`/`configure
off` round-trip**: fixture settings → install → uninstall → byte-identical to fixture except
our once-written `.bak`; `limits` normalizer against the fixture incl. `unknown_window_example`,
`resetsAt: null`, unknown `severity`.

## 23.13 Dashboard contract clarifications (from the Android spec audit, 2026-09-13)
- Session objects (`/v1/sessions`, SSE `session`) carry `lastTool: { name, at } | null`,
  populated by the `PreToolUse` hook: its gate call becomes
  `GET /v1/sessions/{id}/gate?tool=<tool_name>` and the daemon records `{ name, at: now }`.
- SSE `spend` `{ today, delta }` is **machine-wide**; per-project/per-session live burn is
  derived by clients from cumulative `session.update.tokens` and `/v1/tokens`.
- `rule.reason` is echoed **verbatim** (trimmed to 200 chars) in the rule, in `/v1/pause/rules`
  and in the `pause` SSE event, so a client can tag its own rules (e.g. `usage-deck:<installId>`).
- The error envelope **always** carries a non-empty `message` (and `hint` where one exists),
  including `401`/`403`/`421`: e.g. `{ error: { code: "unauthorized", message: "Bearer token
  missing or invalid", hint: "run `claude-usage configure pairing` on the host" } }`.

## 23.15 Pause-rule semantics refined by QA (2026-09-13 evening)
- **One rule per scope.** Posting a rule for a scope that already has one in the *other*
  mode **supersedes** it (soft → hard escalation replaces, never stacks), so
  `GET /v1/pause/rules` never shows two rules for one target and no client has to delete
  the loser. Same `(scope, mode)` is still idempotent (§18.1).
- **Resume cascades downward.** `POST /v1/resume { scope }` lifts every rule *under* the
  target, not only the rule whose scope string matches: `all` lifts everything;
  `project:<key>` lifts that project's rule plus any `session:<id>` rule for a session in
  that project. Resume means "let this run again", so a narrower rule must never survive it.
- **Gate timing (§18.2).** The gate has its own deadline (`GATE_DEADLINE_MS`, 5 s), not the
  §7.1 nudge's 200 ms: gate polls measured 107–300 ms over a LAN address, so the nudge
  budget released paused sessions on latency alone. The gate's sleep timer is **ref'd** —
  an `unref()`ed timer let Node exit mid-sleep, returning from the hook after one poll and
  running the tool anyway. A single transient poll failure no longer releases a pause;
  `GATE_FAILURE_TOLERANCE` (3) consecutive failures do (fail open, never wedge a session).

## 23.16 Hard freeze spares the session's own process (2026-09-13 evening)

`SIGSTOP` on the interactive `claude` process stops the session's TUI. The shell reports it
as `suspended`, takes the foreground back, and after `SIGCONT` the session is a background
job that cannot read the terminal until the user types `fg`. Hard pause is meant to stop
Claude's *work*, not to take the user's terminal away, so:

- **`freezeTree(pid)` `SIGSTOP`s the descendants of `pid`, deepest first, and never `pid`
  itself.** `frozenPids` therefore never contains the session's own pid. Resume `SIGCONT`s
  them nearest-first so a parent shell resumes before the children it owns.
- **The gate does the rest.** Work already in flight is what the freeze stops; the next
  piece of work is stopped by the `PreToolUse` gate (§18.2), which holds for `hard` exactly
  as it does for `soft`. Together they are the pause.
- **Freezing an idle session is a no-op on the process table** and that is correct:
  `frozenPids: []`, nothing stopped because nothing was running, and the next tool call
  blocks at the gate. The CLI renders this as `hard(0)`.
- **A fresh pid is not chased.** A session that re-registers (`claude --resume`) under a
  standing hard rule has its new tree frozen on the next reconcile — which for a
  just-started session means freezing nothing — and is then held at its first gate.

### Reconciler bookkeeping

Because an empty `frozenPids` is now a legitimate frozen state, "already frozen" can no
longer be `frozenPids.length > 0`. Two fields on the stored session carry it:

| Field | Meaning |
| --- | --- |
| `frozenPid` | The root pid the recorded freeze belongs to; `null` when nothing is frozen. `apply()` freezes when `frozenPid !== pid`, which also makes a re-registered session freeze its new tree. Not on the wire. |
| `freezes` | How many times this pause has frozen the session's tool tree. Survives a re-register; reset to `0` when the pause ends. Exposed on `SessionPause`. |

`SessionPause` gains `freezes: number` — `0` under a soft rule, `1` for a session frozen
once, `2+` once a re-register or a daemon restart sweep has frozen it again under the same
standing rule. That is what lets a dashboard tell "frozen again after re-register" from
"frozen once".

A hard → soft downgrade clears `frozenPid` (so a later re-escalation freezes again) but
keeps `freezes`; only ending the pause resets the counter.
