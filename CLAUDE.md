# claude-usage (repo: claude-utilization-mcp)

Local daemon + hooks + MCP server giving Claude Code sessions account rate-limit % and local
token spend; remote dashboards consume it over the LAN (HTTPS, pinned) or Tailscale — the Android
dashboard lives on orphan branch `usage-android` of this repo; the iOS/watch app lives on
`usage-ios`. **Spec is authoritative:** `docs/superpowers/specs/2026-09-13-claude-usage-design.md`
— Part II and Part III override Part I where they conflict. Plan: `docs/superpowers/plans/`.

## Commands
- `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` (dist/, ESM, Node ≥ 20)
- lefthook pre-commit runs lint + typecheck.
- **`main` is protected: changes land through a pull request** (ruleset "daemon: main via pull
  request"; required checks `test (ubuntu-latest)` + `test (macos-latest)`). Never push to
  `main` directly, even though admin rights would bypass it. Branch, `gh pr create`, then
  `gh pr checks --watch && gh pr merge --squash`. Each merge to `main` auto-releases.

## Invariants (violations are silent)
- Never print, log or serialize credential values (`accessToken`, `refreshToken`, bearer token).
  Fixtures under `test/fixtures/` must contain no credentials and no real prompt text.
- Never refresh Anthropic OAuth tokens; never call any Anthropic endpoint other than
  `GET /api/oauth/usage`.
- Hooks always exit 0 and never block; daemon unreachable ⇒ hook prints nothing.
- Every mutating endpoint requires the bearer token, even from loopback. Exceptions: the hooks'
  loopback-only session bookkeeping (§17.1) and `POST /v1/pair` (§23.47 — TLS only, one-time
  pairing code, rate-limited). Never log or print pairing codes.
- Hard-frozen pids must be SIGCONTed on shutdown/uninstall; `claude-usage resume --all`
  must work with the daemon dead.
- Edits to `~/.claude/settings.json` are merge-only; `~/.claude.json` is written via
  `claude mcp add` (fallback: atomic 0600 rename, no .bak).
- Daemon runtime deps: none (stdlib only). `@modelcontextprotocol/sdk` and `qrcode-terminal`
  are loaded lazily by CLI subcommands only.
- Tests are TDD; `test/**/*.test.ts`; use temp dirs via `XDG_CONFIG_HOME`, never the real
  `~/.claude`.
