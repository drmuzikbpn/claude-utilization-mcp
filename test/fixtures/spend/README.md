# `test/fixtures/spend`

Synthetic Claude Code transcripts, modelled on the real line shapes under
`~/.claude/projects/` but containing **no real prompt text, paths, ids or credentials** —
every value is invented.

`projects/` mirrors the layout the scanner walks:

| Path | Purpose |
| --- | --- |
| `-home-dev-alpha/<sessionA>.jsonl` | top-level transcript: counted line, an exact duplicate (same `message.id` + `requestId`), a line with **no** `requestId`, a `<synthetic>` model line, an `isApiErrorMessage: true` line, an assistant line with no `message.usage`, a **malformed JSON** line, a `summary` line and a `user` line |
| `-home-dev-alpha/<sessionA>/subagents/agent-*.jsonl` | nested subagent transcript carrying the **parent's** `sessionId` and a different `cwd` |
| `-home-dev-alpha/vercel-plugin/skill-injections.jsonl` | a non-transcript `.jsonl` in the tree — every line must be skipped silently |
| `-home-dev-beta/<sessionB>.jsonl` | a second project: one line inside a 90-day window from 2026-09-13, one from 2025-01-01 for retention pruning |

Counted totals across the whole tree (no retention applied):
`input 1116, output 2228, cacheCreate 3340, cacheRead 4452, messages 5`, with
`parseErrors: 1`.

Regenerate by hand — these files are checked in and are the contract the
`test/spend/*` suites assert against.
