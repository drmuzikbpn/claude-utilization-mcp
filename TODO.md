# TODO

Open work on the iPhone and Watch app (and the daemon pieces it relies on). Larger
design-level items, such as the push relay and `escalateAfter`, live in the spec's
[Deferred](docs/superpowers/specs/2026-10-01-usage-ios-design.md#deferred) list. Code never
carries `TODO` comments (swiftlint `no_todo`); they go here.

## Release

- [x] TestFlight build numbers only go up: `GITHUB_RUN_NUMBER * 10 + GITHUB_RUN_ATTEMPT`.
- [ ] External TestFlight testing: Beta App Review, a feedback email, and the privacy URL
  (`PRIVACY.md` on GitHub).
- [ ] Add the `test` check as a required check on the `usage-ios` ruleset (repository settings,
  Alan's call).
- [ ] Contract-test CI job: build the daemon from `main`, run it with TLS on loopback, and run the
  UsageCore contract tests (pairing link, pinning, SSE, pause/resume round trip).

## App

- [ ] Watch Projects list: rank by live rate like the phone (`ActivityOrder`); `WatchSnapshot`
  still orders projects by tokens today.
- [ ] Unit-test the landscape gutter rule (`Gutters.of` in `WideDockView.swift`). The app target
  has no unit-test target; move the rule somewhere testable or add one.
- [ ] Demo data (`DemoData`) has no `update` state, so the demo device screen reads "update:
  unknown"; a real daemon always reports it.
- [ ] Pause `DeckBackdrop`'s animation on screens hidden under a pushed screen (a small battery
  cost while they are covered).

## Daemon (`main`)

- [x] `install` puts `claude-usage` on the PATH (`~/.local/bin`, daemon 0.1.109, §23.51).
- [ ] Rotate this Mac's bearer token (`claude-usage configure rotate-token`); it appeared in a
  session transcript. Re-pair the iPhone and the Android deck afterwards.
- [ ] Remove the leftover literal `192.168.1.249` from this Mac's `bind` list now that `lan`
  covers it.
- [ ] Other Macs still on 0.1.107 may need
  `launchctl kickstart gui/$(id -u)/com.github.drmuzikbpn.claude-usage` once to pick up the
  restart watchdog (§23.50).

## Housekeeping

- [ ] Remove the `cum-wt` worktrees (`daemon`, `android`, `ios`, `ios-phone`, `ios-watch`) once
  nothing is in flight on them.
