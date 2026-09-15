# Contributing to claude-usage

Thanks for looking. This branch (`main`) is the local daemon, hooks, CLI and MCP server. The
Android kiosk that consumes it lives on the `usage-deck` branch of the same repository and has
its own contributing notes.

**The spec is authoritative**, not the code:
`docs/superpowers/specs/2026-09-13-claude-usage-design.md`. Part II and Part III override Part I
where they conflict, and Part III is a running log of faults found on real machines — read the
section covering anything you are about to change.

## Ground rules

- **Pull requests only.** `main` does not accept direct pushes. Fork, branch from `main`, open a
  PR against `main`.
- **CI must be green.** `test (ubuntu-latest)` and `test (macos-latest)` are required. Every push
  to `main` cuts a release, so a red `main` ships.
- **Tests are TDD, and a new test must fail first.** Write it, watch it fail against the unfixed
  code, then fix. Several bugs in Part III were introduced by tests that passed against a fake
  which never returned an error — a test that has never failed has not been tested.
- **Use temp dirs.** `XDG_CONFIG_HOME` via the helpers in `test/install/helpers.ts`. A test must
  never touch the real `~/.claude`.
- **No secrets, ever.** Fixtures under `test/fixtures/` contain no credentials and no real prompt
  text. Examples use `example.test` addresses and the documentation IPs already in the tree.

## Invariants

These are the ones whose violation is silent. `CLAUDE.md` holds the full list.

- Never print, log or serialize a credential value — `accessToken`, `refreshToken`, or a bearer
  token.
- Never refresh Anthropic OAuth tokens, and never call any Anthropic endpoint other than
  `GET /api/oauth/usage`.
- Hooks always exit 0 and never block. A daemon that is unreachable means the hook prints nothing.
- Every mutating endpoint requires the bearer token, even from loopback.
- Hard-frozen pids must be `SIGCONT`ed on shutdown and uninstall, and `claude-usage resume --all`
  must work with the daemon dead.
- Edits to `~/.claude/settings.json` are merge-only.
- The daemon has no runtime dependencies — stdlib only. `@modelcontextprotocol/sdk` and
  `qrcode-terminal` are loaded lazily by CLI subcommands.
- Anything after the service step in `install` degrades to a note. A late step must never abort
  and destroy the report of the steps that already succeeded (§23.9, §23.29).

## Setting up

```bash
npm ci
npm test                 # vitest, ~880 tests
npm run typecheck
npm run lint
npm run build            # dist/, ESM, Node >= 20
```

`npm ci` installs the lefthook pre-commit hook for you via `prepare`; it runs lint and
typecheck on every commit.

`docs/smoke-test.md` covers what unit tests cannot: the service really being supervised,
unattended self-update, pause and freeze against live sessions. Run the sections your change
touches on a real machine — most of Part III is faults that every test suite reported as fine.

## Style

- Conventional commit messages: `feat(pause): …`, `fix(service): …`, `docs: …`.
- Every behaviour change comes with a test. Nothing is skipped, and no `TODO`/`FIXME` lands.
- Comments explain *why*, and cite the spec section when there is one. The interesting comments
  in this codebase are the ones recording what was measured on a real machine.
- If a change bends an invariant above, say so in the PR and explain why.

## Reporting problems

Bugs and ideas go in GitHub issues. Anything security-related goes through
[SECURITY.md](SECURITY.md) instead.
