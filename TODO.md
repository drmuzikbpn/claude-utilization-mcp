# TODO

Open work on the iPhone and Watch app (and the daemon pieces it relies on). Larger
design-level items, such as the push relay and `escalateAfter`, live in the spec's
[Deferred](docs/superpowers/specs/2026-10-01-usage-ios-design.md#deferred) list. Code never
carries `TODO` comments (swiftlint `no_todo`); they go here.

## Release

- [ ] **TestFlight build numbers must only go up.** CI sets the build number to the commit count
  (`git rev-list --count HEAD` in `.github/workflows/ci.yml`). A squash merge can lower that count:
  PR #5 uploaded as build 28, after build 29 was already in TestFlight, so testers may still be
  offered the older 29. Number builds from `GITHUB_RUN_NUMBER` plus an offset above 29, then
  upload a fresh build.
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
- [ ] Pause `DeckBackdrop`'s animation on screens hidden under a pushed screen (a small battery
  cost while they are covered).

## Daemon (`main`)

- [ ] `install` should put `claude-usage` on the PATH (for example a link in `~/.local/bin`), or at
  least print the full path when it finishes. `claude-usage install --lan` fails with "command not
  found" right after a normal install.
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
