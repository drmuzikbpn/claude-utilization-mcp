# claude-usage (repo: claude-utilization-mcp)

Local daemon + hooks + MCP server giving Claude Code sessions account rate-limit % and local
token spend; remote dashboard (Android, sibling repo `../android-project`) consumes it over
Tailscale. **Spec is authoritative:** `docs/superpowers/specs/2026-09-13-claude-usage-design.md`
— Part II and Part III override Part I where they conflict. Plan: `docs/superpowers/plans/`.

## Commands
- `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` (dist/, ESM, Node ≥ 20)
- lefthook pre-commit runs lint + typecheck.

## Invariants (violations are silent)
- Never print, log or serialize credential values (`accessToken`, `refreshToken`, bearer token).
  Fixtures under `test/fixtures/` must contain no credentials and no real prompt text.
- Never refresh Anthropic OAuth tokens; never call any Anthropic endpoint other than
  `GET /api/oauth/usage`.
- Hooks always exit 0 and never block; daemon unreachable ⇒ hook prints nothing.
- Every mutating endpoint requires the bearer token, even from loopback.
- Hard-frozen pids must be SIGCONTed on shutdown/uninstall; `claude-usage resume --all`
  must work with the daemon dead.
- Edits to `~/.claude/settings.json` are merge-only; `~/.claude.json` is written via
  `claude mcp add` (fallback: atomic 0600 rename, no .bak).
- Daemon runtime deps: none (stdlib only). `@modelcontextprotocol/sdk` and `qrcode-terminal`
  are loaded lazily by CLI subcommands only.
- Tests are TDD; `test/**/*.test.ts`; use temp dirs via `XDG_CONFIG_HOME`, never the real
  `~/.claude`.
