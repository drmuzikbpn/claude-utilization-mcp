## What

<!-- One or two sentences. Link the issue if there is one. -->

## Why

## How it was tested

- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] New tests fail against the unfixed code (say which, or: no behaviour change)
- [ ] Relevant section of `docs/smoke-test.md` run on a real machine, if this touches install,
      the service, auto-update, pause or freeze (or: not applicable)

## Spec

- [ ] `docs/superpowers/specs/2026-09-13-claude-usage-design.md` updated, **or** no spec-visible
      change. A fault found on a real machine gets a Part III section saying what was measured.

## Deck contract

- [ ] No change to what the `usage-deck` branch expects from the daemon — `limits[]`, the SSE
      stream, the pause API — **or** the matching deck PR is linked above.

## Invariants

- [ ] No credential value printed, logged or serialized; no credentials or real prompt text in
      fixtures
- [ ] Hooks still exit 0 and never block
- [ ] Mutating endpoints still require the bearer token
- [ ] Daemon still has no runtime dependencies
