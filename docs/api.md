# HTTP API

The daemon speaks JSON over `node:http` on `config.port` (default `47291`), on every
address in `config.bind` (default `127.0.0.1` only). One `http.Server` per address, all
sharing one handler.

- Every response is `application/json; charset=utf-8` with `cache-control: no-store`.
  `GET /v1/events` is `text/event-stream` instead.
- No CORS headers are ever sent, on any response.
- Request timeout: 5 s (`/v1/events` is exempt — it is a long-lived stream).
- Request bodies must be JSON objects, ≤ 64 KiB.

## Contents

- [The request gate](#the-request-gate)
- [Error envelope](#error-envelope)
- [`GET /health`](#get-health)
- [`GET /v1/limits`](#get-v1limits)
- [`GET /v1/summary`](#get-v1summary)
- [`POST /v1/refresh`](#post-v1refresh)
- [`GET /v1/tokens`](#get-v1tokens)
- [`GET /v1/config`](#get-v1config)
- [`GET /v1/sessions`](#get-v1sessions)
- [Session lifecycle endpoints](#session-lifecycle-endpoints)
- [Pause and resume](#pause-and-resume)
- [`GET /v1/events` (SSE)](#get-v1events-sse)
- [`limits[]` normalization](#limits-normalization)
- [`since` and `groupBy`](#since-and-groupby)
- [Known deviations from the spec](#known-deviations-from-the-spec)

## The request gate

Every request passes through the same gate, in this order
(`src/server/middleware.ts`):

1. **Loopback detection** — from the socket's remote address (`127.0.0.0/8`, `::1`,
   IPv4-mapped forms). Never from a header.
2. **Host allowlist** — the `Host` header's hostname must be `localhost`, `127.0.0.1`,
   `::1`, an address the daemon is bound to, or the machine's MagicDNS name. If it carries
   a port, that port must be one we listen on. Otherwise **`421 misdirected_request`**.
   (`0.0.0.0` / `::` are never accepted as a `Host` value even when bound.)
3. **Origin** — any request carrying an `Origin` header at all is **`403 forbidden`**.
4. **Auth** —
   - loopback + `GET`/`HEAD` → **no token required**;
   - loopback + `POST` to `/v1/sessions/register`, `/v1/sessions/{id}/heartbeat`,
     `/v1/sessions/{id}/end` → **no token required** (see the deviations section);
   - everything else → `Authorization: Bearer <config.auth.token>`, compared in constant
     time over sha256 digests. Missing or wrong → **`401 unauthorized`**. An empty
     configured token never matches anything.

| Situation | Result |
| --- | --- |
| `GET /health` from `127.0.0.1` | 200, no token |
| `GET /health` from the tailnet, no token | 401 |
| `POST /v1/pause` from `127.0.0.1`, no token | 401 |
| Any request with `Origin:` | 403 |
| `Host: evil.test` | 421 |

## Error envelope

Every non-2xx response is:

```json
{ "error": { "code": "unauthorized", "message": "…", "hint": "…" } }
```

`message` is always present and non-empty; `hint` is present when there is something
actionable. Codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`,
`method_not_allowed`, `misdirected_request`, `conflict`, `gone`, `rate_limited`,
`unavailable`, `internal_error`.

Real examples (`test/fixtures/sessions/errors.json`):

```json
{ "error": { "code": "unauthorized",
             "message": "a valid Authorization: Bearer token is required",
             "hint": "mutating requests need the token even from loopback" } }
```

```json
{ "error": { "code": "conflict",
             "message": "session c70bd853-… was discovered from its transcript and has no trusted pid",
             "hint": "hard freeze needs a session registered by the SessionStart hook — use mode \"soft\"" } }
```

A `405` also sets the `allow` header:

```
$ curl -s -i localhost:47291/v1/refresh
HTTP/1.1 405 Method Not Allowed
allow: POST
{"error":{"code":"method_not_allowed","message":"GET is not allowed on /v1/refresh","hint":"allowed: POST"}}
```

A request that exceeds the 5 s timeout gets `500 internal_error` with
`"request timed out"` and the socket is destroyed.

---

## `GET /health`

Auth: loopback GET exempt. `HEAD` allowed.

```json
{
  "ok": true,
  "name": "alans-mbp",
  "version": "0.1.0",
  "uptimeMs": 631,
  "pid": 48213,
  "user": {
    "emailAddress": "alan@example.test",
    "accountUuid": "c0ffee00-1111-4222-8333-444455556666",
    "organizationUuid": "d1a9b0c2-7777-4888-8999-aaaabbbbcccc",
    "displayName": "Alan Example",
    "organizationName": "Example Productions"
  },
  "update": { "channel": "stable", "current": "0.1.0", "available": null,
              "state": "disabled", "deferredReason": null },
  "stats": { "filesTracked": 4, "eventsIndexed": 4, "parseErrors": 1,
             "lastScanAt": "2026-09-13T19:29:06.194Z", "spendReady": true,
             "scan": { "filesDone": 4, "filesTotal": 4, "bytesDone": 6099, "bytesTotal": 6099 } }
}
```

- `user` is read from `~/.claude.json → oauthAccount` and cached for 10 minutes; a missing
  file, a missing `oauthAccount`, or an object where every verified key is absent all yield
  `null`. No tokens or credentials are ever in this object.
- `stats.eventsIndexed` is the number of dedup keys held; `stats.scan` is present while a
  token store is attached.
- `update.state` is one of `idle | checking | downloading | verifying | ready | deferred |
  disabled`. Today it is always `disabled` (see deviations).

## `GET /v1/limits`

Auth: loopback GET exempt.

The daemon's cached copy of `GET https://api.anthropic.com/api/oauth/usage`
(`anthropic-beta: oauth-2025-04-20`), polled every `pollIntervalMs`.

```json
{
  "fetchedAt": "2026-09-13T19:01:38.189Z",
  "stale": false,
  "error": null,
  "limits": [
    { "id": "session", "kind": "session", "group": "session", "percent": 69,
      "severity": "normal", "resetsAt": "2026-09-13T23:00:00.346Z",
      "scope": null, "isActive": true },
    { "id": "weekly_all", "kind": "weekly_all", "group": "weekly", "percent": 34,
      "severity": "normal", "resetsAt": "2026-09-16T13:00:00.346Z",
      "scope": null, "isActive": false },
    { "id": "weekly_scoped:fable", "kind": "weekly_scoped", "group": "weekly", "percent": 20,
      "severity": "normal", "resetsAt": "2026-09-16T13:00:00.347Z",
      "scope": { "model": "Fable", "surface": null }, "isActive": false }
  ],
  "legacyWindows": {
    "five_hour": { "utilization": 69, "resetsAt": "2026-09-13T23:00:00.346Z" },
    "seven_day": { "utilization": 34, "resetsAt": "2026-09-16T13:00:00.346Z" }
  },
  "extraUsage": { "isEnabled": false, "utilization": null, "spendLimitReached": true },
  "raw": { "…verbatim upstream payload…": true }
}
```

Before the first successful poll: `{ "fetchedAt": null, "stale": false, "error": null,
"limits": [], "legacyWindows": {}, "extraUsage": null, "raw": null }`.

`stale: true` means this is the last good value after a failed fetch, and `error` then
carries one of:

| `error.code` | When |
| --- | --- |
| `no_credentials` | the Keychain item / credentials file is unreadable |
| `unauthorized` | upstream answered 401/403 after one credentials re-read and retry; hint `run \`claude\` to re-login`; the poll interval parks at 10 min until a fetch succeeds |
| `network` | transport failure or a non-2xx that is not 401/403 |
| `schema_drift` | the body was not JSON, not an object, or had no `limits` array |

`raw` is always served verbatim when there is one — `raw` keeps everything the normalizer
ignores.

## `GET /v1/summary`

Auth: loopback GET exempt. This is the hook's and the status line's single call.

```json
{
  "limits": { "…": "/v1/limits minus `raw`" },
  "status": { "byId": { "session": "ok", "weekly_all": "ok", "weekly_scoped:fable": "ok" },
              "overall": "ok" },
  "thresholds": { "warn": 80, "critical": 95 },
  "today": { "ready": true, "input": 7702, "output": 534038,
             "cacheCreate": 10067248, "cacheRead": 192527936, "messages": 1908 }
}
```

- `status` per limit: `critical` if `percent >= thresholds.critical` **or** upstream
  `severity` is one of `critical, severe, exceeded, exhausted, blocked, locked,
  limit_reached, over_limit` (case-insensitive); `warn` if `percent >= thresholds.warn`
  **or** `severity !== "normal"`; else `ok`. `overall` is the worst of them; with no limits
  at all it is `ok`.
- `today` is machine-wide, since **UTC** midnight. `ready: false` (with zeroes) until the
  initial transcript scan completes.

## `POST /v1/refresh`

Auth: **token required** (it is a mutating method, even from loopback).

Forces a limits refetch and returns the new `/v1/limits` body. Rate-limited to one per
10 s:

```json
{ "error": { "code": "rate_limited",
             "message": "limits refresh is rate-limited to one per 10 s",
             "hint": "retry shortly" } }
```

→ `429`. The MCP `refresh_limits` tool catches that and returns the current limits with a
note instead of an error.

## `GET /v1/tokens`

Auth: loopback GET exempt. Query: `?since=<iso|today|all|7d|24h|30m>&groupBy=project|session|model|day`.

```json
{
  "ready": true,
  "stale": false,
  "since": "1970-01-01T00:00:00.000Z",
  "groupBy": "project",
  "totals": { "input": 116, "output": 228, "cacheCreate": 340, "cacheRead": 452, "messages": 4 },
  "groups": [
    { "key": "-home-dev-beta",  "label": "/home/dev/beta",  "input": 100, "output": 200,
      "cacheCreate": 300, "cacheRead": 400, "messages": 1 },
    { "key": "-home-dev-alpha", "label": "/home/dev/alpha", "input": 16, "output": 28,
      "cacheCreate": 40, "cacheRead": 52, "messages": 3 }
  ]
}
```

(Real response from a daemon pointed at `test/fixtures/spend/projects` — see
`test/fixtures/spend/README.md` for the transcript shapes those numbers come from.)

- `ready: false` with empty totals and groups until the initial scan finishes, and also
  when no token store is attached at all.
- `stale: true` means a background rescan is running and the aggregates are behind the
  files on disk.
- For `groupBy=project`, `key` is the `~/.claude/projects/<dir>` directory name used
  verbatim as an opaque key — the encoding is lossy (`/` and `-` both become `-`) so it is
  never decoded. `label` is the `cwd` of the first counted line of the session's top-level
  transcript, falling back to `key`.
- Counting rules: a transcript line counts iff `type === "assistant"` **and**
  `message.model !== "<synthetic>"` **and** `isApiErrorMessage !== true` **and**
  `message.usage` is an object. Dedup key is `message.id + ":" + (requestId ?? "")`.
  Subagent transcripts (`<sessionId>/subagents/agent-*.jsonl`) carry the parent's
  `sessionId` and roll up to it. Non-transcript `.jsonl` files in the tree are skipped
  silently and are not counted as `parseErrors`.

Bad query → `400`:

```json
{ "error": { "code": "bad_request", "message": "invalid \"groupBy\" parameter",
             "hint": "groupBy must be one of project, session, model, day" } }
```

```json
{ "error": { "code": "bad_request", "message": "invalid \"since\" parameter",
             "hint": "since must be an ISO-8601 instant, today, all, or a relative value such as 7d or 24h" } }
```

Passing `groupBy` more than once is a `400` — multiple groupings are not supported.

## `GET /v1/config`

Auth: loopback GET exempt. The effective config with `auth.token` replaced by
`"<redacted>"` (or left `""` when none is set). Unknown keys you added to `config.json`
appear here too.

```json
{ "name": "demo-host", "port": 47291, "bind": ["127.0.0.1"],
  "auth": { "token": "<redacted>" }, "pollIntervalMs": 60000,
  "thresholds": { "warn": 80, "critical": 95 },
  "hookDebounceMinutes": 10, "retentionDays": 90,
  "projectsDir": "/Users/you/.claude/projects",
  "integrations": { "service": true, "hook": true, "mcp": true, "statusline": false },
  "autoUpdate": { "enabled": true, "intervalMs": 600000,
                  "repo": "drmuzikbpn/claude-utilization-mcp" },
  "events": { "maxClients": 16 } }
```

## `GET /v1/sessions`

Auth: loopback GET exempt. `HEAD` allowed. Sets `ETag: W/"<rev>"`; a matching
`If-None-Match` gets **`304`** with the same `etag` and no body.

```json
{
  "rev": 812,
  "sessions": [
    {
      "sessionId": "3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411",
      "pid": 4242,
      "alive": true,
      "discovered": "hook",
      "cwd": "/Users/alan/code/foo-wt2",
      "transcriptPath": "/Users/alan/.claude/projects/-Users-alan-code-foo-wt2/3f1c0a52-….jsonl",
      "project": { "gitCommonDir": "/Users/alan/code/foo/.git", "name": "foo" },
      "worktree": "foo-wt2",
      "model": "claude-opus-5",
      "startedAt": "2026-09-13T11:04:18.000Z",
      "lastActivityAt": "2026-09-13T14:02:51.000Z",
      "tokens": { "input": 18422, "output": 5310, "cacheCreate": 240118,
                  "cacheRead": 1904772, "messages": 143 },
      "pause": { "mode": "hard", "ruleId": "r_k3m7qz4ub2ah6ptc",
                 "scope": "session:3f1c0a52-…", "since": "2026-09-13T14:03:10.000Z",
                 "frozenPids": [4251, 4252], "freezes": 1 },
      "lastTool": { "name": "Bash", "at": "2026-09-13T14:02:50.000Z" }
    }
  ]
}
```

Full three-session example including a `discovered: "transcript"` one:
[`test/fixtures/sessions/sessions.json`](../test/fixtures/sessions/sessions.json).

- `rev` is a monotonic counter bumped on any session or pause change.
- `project.name` is the basename of the main worktree (the parent of `gitCommonDir`);
  `worktree` is the basename of `cwd` when it differs, else `null`. With
  `gitCommonDir: null` the project is `{ gitCommonDir: null, name: basename(cwd) }`.
- `discovered: "hook"` means a `SessionStart` hook registered it; `"transcript"` means it
  was back-filled from the spend store and has `pid: null`.
- Liveness: every 15 s the daemon `kill(pid, 0)`s each registered pid. Dead → `alive:
  false`; dropped from the list 5 minutes later.
- `model`, `tokens` and `startedAt` come from the spend store, keyed by `sessionId`.
- `lastTool` is recorded by the `PreToolUse` hook's gate call.
- `pause.frozenPids` lists the **tool subprocesses** currently `SIGSTOP`ed. The session's own
  `claude` process is never among them — a hard pause stops Claude's work, not the user's
  terminal, and the next tool call is stopped by the gate instead. An empty list under
  `mode: "hard"` means the session had nothing running when the pause landed; it is held at
  the gate.
- A `discovered: "transcript"` session reports `alive: false` once the daemon has seen it
  stop, even while its transcript is recent — a recently-written transcript is evidence of
  recent activity, never of a running process (§23.24).
- `pause.freezes` counts how many times this pause has frozen the session's tool tree: `0`
  under a soft rule, `1` for a session frozen once, and `2+` once a re-registered session
  (`claude --resume`, new pid) or a daemon restart sweep has frozen it again under the same
  standing rule. It resets when the pause ends.

## Session lifecycle endpoints

These are what `claude-usage hook` calls. All three are `POST`, and all three are exempt
from the token **from loopback only**.

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /v1/sessions/register` | `{ sessionId, pid, cwd, transcriptPath, gitCommonDir, source }` | `200 { session, rev }` |
| `POST /v1/sessions/{id}/heartbeat` | `{}` | `200 { ok: true, rev, paused, mode, ruleId, reason }`; `404` for an unknown session |
| `POST /v1/sessions/{id}/end` | `{}` | `200 { ok: true, ended: <bool>, rev }` — idempotent |
| `GET /v1/sessions/{id}/gate?tool=<name>` | — | `200 { paused, mode, ruleId, reason }` |

- `register` requires a non-empty `sessionId` (`400` otherwise) and is idempotent —
  `claude --resume` re-registers the same id with a new pid. Registering applies any rule
  created before the session existed.
- `gate` is a loopback GET, so the hook needs no token. `?tool=` records `lastTool`.
- `end` SIGCONTs the session's recorded `frozenPids` first, so a stopped process can never
  outlive the session that owned it.

## Pause and resume

All mutating endpoints require the bearer token. Scopes are `all`,
`project:<gitCommonDir>` and `session:<sessionId>`; a trailing `/` on a project path is
stripped.

| Method & path | Body → response |
| --- | --- |
| `POST /v1/pause` | `{ scope, mode, reason? }` → `200 { rule, affected: [sessionId…] }` |
| `POST /v1/resume` | `{ scope }` → `200 { removed: [ruleId…], resumed: [sessionId…] }` |
| `GET /v1/pause/rules` | → `200 { rev, rules: [...] }` |
| `DELETE /v1/pause/rules/{id}` | → `204`, or `404 not_found` |
| `POST /v1/sessions/{id}/pause` | `{ mode, reason? }` — sugar for `scope: "session:<id>"` |
| `POST /v1/sessions/{id}/resume` | — sugar for `scope: "session:<id>"` |

Rule shape ([`test/fixtures/sessions/pause-rules.json`](../test/fixtures/sessions/pause-rules.json)):

```json
{ "id": "r_k3m7qz4ub2ah6ptc",
  "scope": "session:3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411",
  "mode": "hard",
  "reason": "usage-deck:9f21c4ab",
  "createdAt": "2026-09-13T14:03:10.000Z",
  "createdBy": "dashboard" }
```

`POST /v1/pause` →
[`test/fixtures/sessions/pause-response.json`](../test/fixtures/sessions/pause-response.json);
`POST /v1/resume` →
[`test/fixtures/sessions/resume-response.json`](../test/fixtures/sessions/resume-response.json).

Semantics:

- **Rules, not flags.** A session's effective pause is the most specific matching rule
  (session > project > all); `hard` beats `soft` at equal specificity. Rules persist in
  `<configDir>/pause.json` across restarts and apply to sessions that register *later* — a
  new worktree session in a paused project comes up paused.
- Posting the same `(scope, mode)` twice returns the existing rule (idempotent).
- `reason` is echoed verbatim, trimmed to 200 characters, everywhere the rule appears —
  so a client can tag its own rules (`usage-deck:<installId>`).
- `resume` is idempotent: empty arrays when nothing matched.
- Mode validation: anything but `"soft"` / `"hard"` → `400`; a malformed scope → `400`.

Hard-freeze refusals, before any rule is created:

| Status | Code | When |
| --- | --- | --- |
| `409` | `conflict` | the session is `discovered: "transcript"` (no trusted pid) |
| `409` | `conflict` | the target pid is not owned by the daemon's uid |
| `410` | `gone` | the session is unknown, has exited, or its pid is gone |

`400` bodies are rejected the same way everywhere: a body that is not a JSON object (or
over 64 KiB) → `{ "error": { "code": "bad_request", "message": "body must be a JSON
object" } }`.

## `GET /v1/events` (SSE)

Auth: loopback GET exempt (and only `GET`/`HEAD`; anything else is `405` with
`allow: GET, HEAD`). `HEAD` returns `200` with the stream headers and no body.

Response headers:

```
content-type: text/event-stream; charset=utf-8
cache-control: no-store
x-accel-buffering: no
```

Wire format — `retry:` first, then one `\n\n`-terminated frame per event, `id:` being the
event bus revision at send time:

```
retry: 3000

id: 3
event: snapshot
data: {"name":"alans-mbp","version":"0.1.0","user":{…},"limits":{…},"summary":{…},"sessions":[…],"rules":[…],"update":{…},"rev":3}

id: 4
event: pause
data: {"rules":[],"affected":["3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11"]}

id: 5
event: session
data: {"type":"update","session":{"sessionId":"3f6c1a2e-…","pid":48213,"alive":true,…}}

id: 6
event: spend
data: {"today":{"ready":true,"input":7704,"output":534151,"cacheCreate":10071412,"cacheRead":192771920,"messages":1909},"delta":{"input":7704,"output":534151,"cacheCreate":10071412,"cacheRead":192771920,"messages":1909}}

id: 7
event: spend
data: {"today":{"ready":true,"input":7708,"output":535706,"cacheCreate":10077392,"cacheRead":193378631,"messages":1911},"delta":{"input":4,"output":1555,"cacheCreate":5980,"cacheRead":606711,"messages":2}}

id: 11
event: heartbeat
data: {"rev":11,"at":"2026-09-13T19:01:56.885Z"}
```

That excerpt is the checked-in fixture
[`test/fixtures/events/stream.sse`](../test/fixtures/events/stream.sse), captured from a
real daemon; the `snapshot` frame's payload is also stored pretty-printed as
[`test/fixtures/events/snapshot.json`](../test/fixtures/events/snapshot.json).

| Event | Payload |
| --- | --- |
| `snapshot` | `{ name, version, user, limits, summary, sessions, rules, update, rev }` — `limits` is `/v1/limits` minus `raw`, `summary` is the `/v1/summary` body, so a client can label the machine without a second call |
| `limits` | `/v1/limits` minus `raw`, on each poll whose numbers actually changed |
| `spend` | `{ today, delta }`, machine-wide, coalesced to ≤ 1 per second (a coalesced `delta` is the sum of what was merged away; `today` is the newest reading) |
| `session` | `{ type: "start" \| "end" \| "update", session }` |
| `pause` | `{ rules, affected }` |
| `update` | the `/health.update` object |
| `heartbeat` | `{ rev, at }`, every 15 s |

- Every connect — including reconnects — starts with a fresh `snapshot`. `Last-Event-ID`
  is deliberately ignored.
- Back-pressure: a client whose socket has been unwritable for more than 30 s is
  destroyed. It reconnects and gets a new snapshot.
- At most `events.maxClients` (default 16) concurrent streams; beyond that, `503`:
  `{ "error": { "code": "unavailable", "message": "at most 16 concurrent event streams are
  served", "hint": "close an open stream, or raise events.maxClients in config.json" } }`.
- No WebSocket. Polling fallback for clients that cannot do SSE: `/v1/summary` plus
  `/v1/sessions` with `If-None-Match`, at ≥ 2 s intervals.

## `limits[]` normalization

`limits[]` is mapped 1:1 from the upstream `limits[]` array — the only authoritative model
in that payload. Unknown top-level keys (including unreleased windows) are ignored;
`raw` keeps them.

| Field | Rule |
| --- | --- |
| `id` | `kind`, plus `":" + scope.model.display_name.toLowerCase()` when a scoped model is present — e.g. `session`, `weekly_all`, `weekly_scoped:fable` |
| `kind` | upstream `kind`; an entry without a string `kind` is dropped entirely |
| `group` | upstream `group`, or `null` |
| `percent` | upstream integer, rounded; `null` when absent. **Thresholds are evaluated on `percent` only** — the float `utilization` in `legacyWindows` can differ by rounding |
| `severity` | upstream string passed through untouched, `null` when absent; unknown values never throw |
| `resetsAt` | upstream `resets_at` normalized through `Date` to ISO-8601 `Z`. **May be `null`** — every renderer must cope ("resets: unknown") |
| `scope` | `{ model, surface }`, each `display_name` or the raw string, each nullable; `null` when there is no scope object |
| `isActive` | `upstream.is_active === true` |

`legacyWindows` is a best-effort passthrough of `five_hour` and `seven_day` **only**
(`{ utilization, resetsAt }` each). `seven_day_opus` and friends are not promised.
`extraUsage` is `{ isEnabled, utilization, spendLimitReached }` from upstream
`extra_usage`, or `null`. Upstream's dollar-denominated `spend` object is surfaced only
through `extraUsage` and `raw` — which is why our token endpoint is `/v1/tokens`, not
`/v1/spend`.

## `since` and `groupBy`

`since` accepts:

| Value | Meaning |
| --- | --- |
| omitted / `today` | **UTC** midnight of the current day |
| `all` | `1970-01-01T00:00:00.000Z` |
| `<N>m` / `<N>h` / `<N>d` | now minus N minutes / hours / days |
| anything `Date.parse` accepts | that instant, re-emitted as ISO-8601 `Z` |

Anything else → `400`. The resolved instant is echoed back as `since` in the response.

Aggregates are keyed by **UTC day**, so `since` is effectively day-grained: a mid-day
`since` includes the whole UTC day it falls in. `/v1/summary.today` uses the same UTC
midnight, so the two agree.

`groupBy` is one of `project` (default), `session`, `model`, `day`. Exactly one value.

---

## Known deviations from the spec

Read against `docs/superpowers/specs/2026-09-13-claude-usage-design.md` (Part II/III
override Part I). Where the code and the spec differ, the code is what this document
describes; these are the differences worth knowing.

1. **Three `POST` endpoints are token-exempt from loopback.** §16 and `CLAUDE.md` say
   *every* mutating endpoint requires the bearer token, even from loopback.
   `src/server/middleware.ts` carves out `POST /v1/sessions/register`,
   `/v1/sessions/{id}/heartbeat` and `/v1/sessions/{id}/end` for loopback callers only,
   because Claude Code runs `claude-usage hook` as a bare command with no way to read the
   token, and a `SessionStart` that cannot register makes the whole sessions view wrong.
   They are write-only bookkeeping keyed by a session id the caller must already know, and
   return no data. From the tailnet they still require the token. Pause/resume are
   deliberately not on the list.
2. **Two different `rev` counters.** `/v1/sessions.rev`, the `ETag`, and
   `/v1/pause/rules.rev` come from the session registry. The SSE `id:` field, the
   `snapshot.rev` and the `heartbeat.rev` come from the event bus, which counts *all*
   publishes. The spec reads as if there is one counter. Clients must not compare an SSE
   `id:` with a sessions `rev`.
3. **`createdBy` is inferred, not taken from the body.** `src/sessions/routes.ts` sets
   `createdBy: "dashboard"` when the request carried an `Authorization` header and
   `"cli"` when it did not. Since the CLI authenticates with the bearer token, a
   `claude-usage pause` is recorded as `createdBy: "dashboard"` — the `createdBy` the CLI
   puts in the body is ignored.
4. **`affected` counts registered sessions only.** `POST /v1/pause` returns the sessions
   the reconciliation pass walked, which is the persisted registry. Transcript-back-filled
   sessions are not in it, even though `GET /v1/sessions` will show them with a resolved
   `pause` object.
5. **`hookDebounceMinutes` is not read by the hook.** `src/hook.ts` uses its own
   `DEFAULT_DEBOUNCE_MINUTES = 10` and never loads `config.json`. The key is validated and
   stored; changing it currently has no effect.
6. **`retentionDays` is not passed to the spend store.** `src/daemon.ts` builds the store
   with `projectsDir` and `stateDir` only, so the store's own default of 90 days applies.
   Same situation: valid key, no effect.
7. **`/v1/config` returns the whole redacted config**, not §4's "thresholds, port, poll
   interval, resolved paths, enabled integrations". There is no `resolvedPaths` field.
8. **`update` is hard-coded to `disabled`.** `src/server/snapshot.ts#updateBody` returns
   `{ channel: "stable", current: <version>, available: null, state: "disabled",
   deferredReason: null }`. §20's auto-update, `claude-usage update` / `rollback` and the
   release pipeline are landing in the next merge; the `update` SSE event exists on the bus
   but nothing publishes it yet.
9. **Version string is the `package.json` version** (`0.1.0`), not §20's
   `MAJOR.MINOR.<commit-count>+<short-sha>`. That format arrives with the release job.
10. **`since` accepts more than the spec lists.** §4 documents `iso|7d|24h|today`; the
    parser also takes `all` and `<N>m`.
11. **`/v1/tokens` carries fields §4 did not list** — `stale`, and `label` on each group.
    Both come from the implementation plan's shared contract rather than the spec text.
12. **`5xx` on a slow request.** §4 specifies a 5 s request timeout but no status; the
    implementation answers `500 internal_error` with `"request timed out"` and destroys
    the socket.
13. **Preflight treats old Node as a warning, not a failure.** §8 step 1 says fail early
    on Node < 20; `src/install/preflight.ts` warns and continues (an unsupported platform
    is still a hard failure). Unreadable credentials are also a warning, by design.
14. **systemd uses `Restart=on-failure`** (§23.9) rather than §8's `Restart=always`, and
    adds `RestartSec=5`, `After=network.target`, `Type=simple`. Part III wins, as specified.
15. **The CLI subcommand is `tokens`, not `spend`.** §7.4's `claude-usage spend --since 7d
    --by project` is `claude-usage tokens --since 7d --by project`, following §23.3's
    rename of the endpoint. There is also an undocumented `claude-usage config` subcommand
    (prints the effective config as JSON) that `help` does not list, and `version` / `-V`
    as aliases of `--version`.
16. **MCP exposes five tools, not four.** §7.2 lists `get_limits`, `get_spend`,
    `get_summary`, `refresh_limits`; the code ships `get_limits`, `get_summary`,
    `get_tokens` (§23.3's rename), `get_sessions` (added by the implementation plan) and
    `refresh_limits`. `get_limits` and `refresh_limits` strip `raw` before returning.
