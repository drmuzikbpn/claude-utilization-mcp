# claude-usage implementation plan

Spec: `../specs/2026-09-13-claude-usage-design.md` (Part II/III override Part I). Two Opus
implementers at a time, each in its own git worktree/branch, disjoint file sets; the
orchestrator merges to `main` and integrates. TDD per module; `npm run lint && npm run
typecheck && npm test` must be green before every commit.

## Shared contracts (write these first, in the branch that owns them)
- `src/spend/index.ts` (owner: W1) exports `class SpendStore` — `query(q: TokensQuery): TokensResponse`,
  `ready: boolean`, `stats: ScanStats`, `sessionTotals(sessionId): TokenTotals | null`,
  `sessionModel(sessionId): string | null`, `sessionStartedAt(sessionId): string | null`,
  `start(projectsDir): Promise<void>`, `stop(): Promise<void>`, `onChange(cb)`; plus
  `types.ts` with `TokenTotals {input, output, cacheCreate, cacheRead, messages}`,
  `TokensQuery {since: string, groupBy: 'project'|'session'|'model'|'day'}`,
  `TokensResponse {ready, stale, since, groupBy, totals, groups: [{key, label, ...TokenTotals}]}`.
- `src/server/types.ts` (owner: W2) declares the narrow `TokensSource` interface the server
  consumes (same method names as above) so W2 can test with a fake before W1 lands.
- Error envelope everywhere: `{ error: { code, message, hint? } }`.

## Waves
| Wave | Branch | Scope | Spec |
| --- | --- | --- | --- |
| W1 | `feat/spend` | `src/spend/*` scanner (chunked positional reads, recursive walk incl. `subagents/`, line filter, dedup), store (aggregates, retention, atomic snapshot, background rescan), watcher (recursive + 5-min sweep, pre-scan queueing) + fixtures + tests | §5.3, §23.4–23.8, §11 |
| W2 | `feat/core-server` | `src/config.ts`, `src/credentials/*`, `src/limits/{client,normalize,poller}`, `src/server/*` (routing, Host/Origin/auth middleware, `/health`, `/v1/limits`, `/v1/summary`, `/v1/refresh`, `/v1/config`, `/v1/tokens` via `TokensSource`), `src/clients/http.ts`, `src/daemon.ts`, `src/cli.ts` (`serve`, `status`, `tokens`), `src/hook.ts` nudge path, `src/statusline.ts` + tests | §4–§7.1, §7.3, §9, §10, §15, §16 (loopback rules), §23.2–23.3 |
| W3 | `feat/sessions-pause` | `src/sessions/*` registry + liveness + transcript back-fill, `src/pause/*` rules + gate + hard freeze (process tree, signals, orphan sweep), endpoints, hook events (SessionStart/End/heartbeat/gate), CLI `sessions/pause/resume [--all]` offline mode | §17, §18, §23.11 |
| W4 | `feat/events` | `src/server/events.ts` SSE (snapshot, coalescing, heartbeat, eviction) | §19 |
| W5 | `feat/network-auth` | bind list + tailscale resolve, bearer generation/rotation, pairing QR, SIGHUP re-resolve | §16, §21 |
| W6 | `feat/install` | `src/install/*` preflight/plan/confirm, settings merge (once-written .bak), `claude mcp add` + fallback, `src/service/{launchd,systemd,noop}`, `configure`, `uninstall`, status log tail | §8, §23.9–23.11 |
| W7 | `feat/mcp` | `src/mcp.ts` tools `get_limits/get_tokens/get_summary/refresh_limits/get_sessions` | §7.2 |
| W8 | `feat/autoupdate` | `src/update/*` versions dir, release check, sha256 verify, smoke, repoint, deferral, rollback; CI release job (`MAJOR.MINOR.<count>+<sha>`, tarball + SHA256SUMS, npm publish) | §20 |
| W9 | docs | README (pairing, security model, escape hatch, trademark footer), `docs/smoke-test.md`, `docs/api.md` | — |

Pairing: W1‖W2 → W3‖W4 → W5‖W6 → W7‖W8 → W9. Orchestrator merges after each pair,
runs the full suite, and pings the Android session at milestones: after W3 (sessions/pause on
loopback), W4 (SSE), W5 (tailnet+bearer+pairing).

## Per-wave definition of done
1. Tests written first and failing, then passing; fixtures contain no credentials/prompt text.
2. `npm run lint && npm run typecheck && npm test` green; no new runtime deps in the daemon path.
3. Commits small, messages end with the session's Co-Authored-By line.
4. Final report lists: files, public interfaces, deviations from spec (with reason), open questions.
