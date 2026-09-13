# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are `MAJOR.MINOR.<commit-count>+<sha>` (see `docs/api.md`).

## [Unreleased]

### Added
- Daemon (`claude-usage serve`): rate-limit windows from the Claude Code OAuth usage endpoint, normalized to `limits[]`; local token spend indexed from `~/.claude/projects/**/*.jsonl` including subagent transcripts, deduplicated, snapshotted to disk.
- HTTP API on loopback (+ optional Tailscale bind): `/health`, `/v1/limits`, `/v1/summary`, `/v1/tokens`, `/v1/refresh`, `/v1/config`, `/v1/sessions` (+ register/heartbeat/end/gate), `/v1/pause`, `/v1/resume`, `/v1/pause/rules`, `/v1/events` (SSE). Bearer token required for every mutating request and for every non-loopback request; Host allowlist; `Origin` rejected.
- Sessions registry fed by Claude Code hooks (SessionStart / UserPromptSubmit / PreToolUse / SessionEnd), worktree-aware project grouping, `lastTool`.
- Pause rules (`all` / `project:<git-common-dir>` / `session:<id>`): soft pause via hook gate, hard freeze via SIGSTOP/SIGCONT with orphan sweep and the offline `claude-usage resume --all` escape hatch.
- `UserPromptSubmit` nudge at 80 % / 95 % (inform-only, never blocks), statusline with pause marker, MCP server (`get_limits`, `get_summary`, `get_tokens`, `get_sessions`, `refresh_limits`).
- `install` / `configure` / `uninstall`: launchd + systemd user units, merge-only `~/.claude/settings.json` edits with a once-written `.bak`, MCP registration via `claude mcp add`, pairing payload + QR for the remote dashboard.
- Auto-update from GitHub Releases (sha256-verified, versions layout with `current` symlink, deferral while sessions are hard-frozen, `rollback`); release workflow tags, publishes and (when `NPM_TOKEN` is set) npm-publishes every green push to `main`.
