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
