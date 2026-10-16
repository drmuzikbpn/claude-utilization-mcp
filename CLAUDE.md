# Usage Deck for iPhone + Apple Watch — working notes

iPhone app (relay + full dashboard) and single-target watchOS app that read Claude account
rate-limit % and local token spend from paired `claude-usage` daemons and pause/resume sessions.
Lives on the orphan branch `usage-ios` of `drmuzikbpn/claude-utilization-mcp`.
**Spec is authoritative:** `docs/superpowers/specs/2026-10-01-usage-ios-design.md` — its
"Audit amendments" override the earlier text, and its "Hardening amendments" override both.
Wire contract: daemon spec §23.44–§23.48 on `main`. Licence: MIT (`LICENSE`); fonts are OFL.

## Commands

```bash
(cd Packages/UsageCore && swift test)          # core logic, runs on the Mac (macOS 15 platform)
xcodegen generate                              # UsageDeck.xcodeproj is generated, never committed
xcodebuild -project UsageDeck.xcodeproj -scheme UsageDeck \
  -destination 'generic/platform=iOS Simulator' build        # also builds + embeds the watch app
xcodebuild -project UsageDeck.xcodeproj -scheme UsageDeck \
  -destination 'platform=iOS Simulator,name=<an iOS 18+ iPhone>' test   # UI smoke test (demo data)
xcodebuild -project UsageDeck.xcodeproj -scheme UsageDeckWatch \
  -destination 'generic/platform=watchOS Simulator' build
swiftformat . && swiftlint lint --strict        # lefthook runs both + `swift build` on pre-commit
scripts/check-license-headers.sh                # every .swift/.sh/.py/.yml starts with the SPDX header
scripts/public-check.sh --self-test             # the commit-time public-repository check (see below)
python3 ci/es256.py --self-test                 # the App Store Connect token signer, offline
TEST_RUNNER_WIDGET_SHOTS_DIR=<dir> xcodebuild -project UsageDeck.xcodeproj -scheme WidgetRender \
  -destination 'platform=iOS Simulator,name=<iPhone>' test          # every widget family → PNG
#   same with -scheme ComplicationRender on a watchOS simulator for the complications
swift scripts/make-icon.swift App/Assets.xcassets/AppIcon.appiconset/icon-1024.png   # app icon
```

## Releases (TestFlight only)

- `.github/workflows/ci.yml`: lint + `swift test` + both builds on every push/PR to `usage-ios`;
  a push to `usage-ios` also archives, exports and uploads to TestFlight. It never creates a
  GitHub Release or tag (the daemon's updater reads `/releases/latest`, §23.17).
- Build number = `(GITHUB_RUN_NUMBER + 1000) * 10 + GITHUB_RUN_ATTEMPT`, which only ever goes up
  (the commit count did not: a squash merge shortened history and build 28 followed 29).
  TestFlight rejects a non-increasing number. The `+ 1000` is an offset, not decoration:
  recreating the repository restarts `GITHUB_RUN_NUMBER` at 1, the last build from before was
  run 110 (build 110x), so the first run afterwards is build 10011. **Never lower the offset.**
  Version = `MARKETING_VERSION` (`1.0`, the first App Store release).
- CI is pinned: every `uses:` is a full commit SHA with the tag in a trailing comment;
  `ci/install-tools.sh` installs XcodeGen (and SwiftLint/SwiftFormat for the lint job) at exact
  versions checked against SHA-256 digests; nothing is installed with pip (`ci/es256.py` signs
  the App Store Connect JWT through the system `openssl`, key on stdin). The `test` job has no
  secrets and `contents: read`. The `testflight` job runs in the **`release` environment** and
  reads `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8` only on the two steps that use them, plus
  `DIST_P12_B64` / `DIST_P12_PASSWORD` on the keychain step; an `always()` step deletes the
  keychain, key files, archive, export and profiles. Keep all of that true when editing it.
- `MARKETING_VERSION` must equal the App Store version that is waiting for a build (0.x until the
  first public release, which is 1.0): a build of any other version cannot be attached to it, and
  the app page then shows the placeholder icon. lefthook's pre-push runs `ci/check-version.sh`
  (`ci/asc.py version`, through `op run --env-file ci/asc.env.tmpl`: the three App Store Connect
  values and nothing else, never the distribution certificate); it blocks on a mismatch and
  only reports when it cannot check.
- Signing: Debug automatic; Release manual — "Apple Distribution: Even Seal Productions LLC
  (YTHBPWUU3Z)" + four App Store profiles named `UsageDeck AppStore`, `UsageWidgets AppStore`,
  `UsageDeckWatch AppStore`, `UsageComplications AppStore` (all carry
  `group.com.evenseal.usagedeck`). CI installs the profiles by name with `ci/asc.py profiles …`.
- Secrets: the release secrets in 1Password are the source of truth (`.env.tmpl` lists the
  references); the `release` environment's secrets are loaded from it with
  `op read … | gh secret set NAME --env release` (never as an argument). Profiles and the
  certificate expire 2027-10-02.
- App Store Connect app: "Usage Deck", id 6818383053, SKU `usagedeck-ios`.

lefthook is installed (`lefthook install`); the git hooks dir is shared with the other worktrees
of this repo and runs whichever `lefthook.yml` the committing worktree has. Never `--no-verify`.

**This repository is public.** Pre-commit runs `scripts/public-check.sh` on the staged added
lines and blocks credential shapes, e-mail addresses off its allowlist, `/Users/<name>/` and
`/home/<name>/` paths, IPv4 addresses outside loopback and the documentation ranges
(192.0.2.x, 198.51.100.x, 203.0.113.x), carrier-grade NAT addresses, tailnet names, and an
author or committer other than the project identity; it also runs gitleaks when installed and
reads an untracked `.public-check.local` of extra literals. New fixtures and docs use
`example.test`, documentation addresses and `/Users/you/`. In prose say "the owner", never a
person's name; never name a real machine or address. `public-check:allow` on a line is for a
documented false positive only.

## Layout

| Path | What lives there |
| --- | --- |
| `Packages/UsageCore/` | SwiftPM, no UI. `Daemon/` (DTOs, `DaemonAPI`, `EventStream`, `Endpoints`, errors), `Net/` (`PinnedTrust`, `BoundedBody`), `Pairing/`, `Device/` (`DeviceReducer` + `DeviceClient` actor), `Model/` (`TeamState`, `Aging`, `BurnHistory`, `Version`, `Highest`, `SetupCheck`, `UserNames`), `Pause/`, `Alerts/`, `Format/`, `Watch/` (`WatchSnapshot`, wire messages), `Storage/TokenStore`. Linked by all four targets. |
| `App/` | iOS app `com.evenseal.usagedeck` (iOS 18). `Store/` (`DeckStore` — the one `@Observable` app model; `WatchBridge`, `AlertNotifier`, `BackgroundRefresh`, `DemoData` — "Try the demo" on the empty home screen in every build, memory-only and left before any real pairing; its launch arguments are Debug-only), `UI/` (Ledger, WideDock, Project/Projects, Device, Settings, Pairing, shared `Components/`), `Theme/` (palette, `DeckBackdrop` aurora tinted by the worst limit, `deckCard`, zoom sources; bundled OFL fonts in `Resources/Fonts`). The app also compiles `SharedUI/Theme.swift`, `RingGauge.swift` and `Materials.swift` (`deckGlass`: Liquid Glass on iOS/watchOS 26, frosted material before) so phone and watch draw the same rings and glass. Home lists rank by live rate (`ActivityOrder`, 5-minute `BurnHistory.rateWindow`), not by tokens today. App logic that can be tested without UIKit lives in UsageCore `Deck/` (`DeckSettings`, `DeviceRegistry`, `InstallID`, `AddressMerge`, `PairingInput`, `DeckText` + `DeviceName` — what may be Markdown and what a name may hold; `PairingFlow` + `PairingPrompt` — the pairing sheet's state, what a link from outside may do, and the confirmation's wording; `PauseVisuals`, `HomeEmpty`, `DeckAlerts`, `SnapshotDiff`, `FirstLoad` — when a freshly paired device's first refresh has landed, so the "Connecting…" overlay never hands over to rows of "unknown"; `ConnectTracker` — one attempt at a time, foreground-only timeout; `RepairNotice` — the copy for a lost pairing). |
| `AppUITests/` | XCUITest smoke test: launches with `-UsageDeckDemo` (Debug only, made-up devices, no daemon) and walks every screen; `TryTheDemoTests` runs with no arguments, as App Review does. |
| `Watch/` | watchOS app `com.evenseal.usagedeck.watchkitapp` (watchOS 11), single target. |
| `Widgets/` | iOS widget extension `.widgets`. |
| `Complications/` | watchOS widget extension `.watchkitapp.complications`. |
| `project.yml` | XcodeGen. App Group `group.com.evenseal.usagedeck`, URL scheme `usagedeck`, Swift 6 strict concurrency. |
| `ci/`, `scripts/` | `asc.py` + `es256.py` (App Store Connect), `install-tools.sh`, `check-version.sh` + `asc.env.tmpl`; `public-check.sh`, `check-license-headers.sh`, `make-icon.swift`. |
| `docs/images/` | README screenshots, all from demo data (`-UsageDeckDemo`, `-sampleSnapshot`), never a real device. |

Test fixtures (`Packages/UsageCore/Tests/UsageCoreTests/Fixtures/`) are verbatim copies of the
Android deck's (themselves the daemon's `test/fixtures/`), plus `tls-cert.der` /
`tls-fingerprint.txt` copied from the daemon's `test/fixtures/tls/` — the shared pinning
fixture both sides must hash identically.

## Invariants (violations are silent)

- **The bearer token never leaves the iPhone Keychain** (`KeychainTokenStore`,
  `AfterFirstUnlockThisDeviceOnly`, never synchronizable). Never UserDefaults, never the App
  Group, never a WatchConnectivity payload (`WatchSnapshot` carries no token, address or
  fingerprint), never a log line. `DeviceConfig`, `PairResponseDTO`, `PairingInvite` and
  `LegacyPairing` redact secrets from `description`/`dump`; keep it that way for any new type
  that holds one. The swiftlint `no_token_logging` rule backs this up.
- **Removing a device deletes the iPhone's copy of its token; it does not revoke it** (only
  `claude-usage configure rotate-token` on the machine does — the README says so). Tokens with
  no matching `DeviceRecord` (the Keychain outlives an uninstall) are deleted by
  `TokenHygiene.sweep` once per launch, on the first activation, never earlier: before the first
  unlock neither the paired list nor the Keychain can be read.
- **Text from outside is never Markdown.** SwiftUI parses a string literal as Markdown,
  interpolations included. Anything a pairing link, an invite or a device had a hand in (names,
  addresses, session titles, error hints) is drawn with `Text(verbatim:)` or as a `DeckText`,
  whose Markdown segments can only be made from a `StaticString`. swiftlint
  (`no_interpolated_markdown*`, `no_markdown_from_variable`) fails on a new offender. A parse
  error never quotes the offending value. Device names are cleaned by `DeviceName.clean`
  (no control/format characters, 64 characters) wherever one enters: invite, pairing reply, `/health`.
- **Pinning is the whole of trust.** Every device URL is `https://`; `PinnedTrust` accepts a
  server trust iff sha256(P-256 SPKI header ‖ `SecKeyCopyExternalRepresentation`) equals the
  paired `fp`, and refuses every other challenge. Same pin on every candidate address. No
  `NSAllowsArbitraryLoads`, ever. Every session is made by `PinnedTrust.session`, whose delegate
  also **refuses every HTTP redirect** (a 3xx is an error; the bearer never leaves the pinned
  address). `PinRejections` is keyed by fingerprint: a refusal on one device never marks another.
- A device is not trusted about size: REST bodies go through `BoundedBody` (4 MiB; 64 KiB for
  pairing and error envelopes), SSE lines and events are capped (`SSEParser.Limits`), an ETag
  over 256 bytes is dropped, invites keep 8 addresses and a record 16.
- Every request carries the bearer except `POST /v1/pair` — **including `/health`** (without one
  the daemon answers liveness only, with no identity or install state, and the setup check
  would read as a failure).
- Pairing link (`usagedeck://pair?v=2&name&addrs&port&fp&code`) carries a one-time code, never the
  bearer; `PairingClient` redeems it with `POST /v1/pair` (the one bearer-less endpoint).
- **Only `usagedeck://pair…` does anything.** Any other host (`usagedeck://open` from the
  widgets) just brings the app forward: `PairingFlow.open` ignores it and leaves a Re-pair in
  progress alone. An invite that arrives as a link never inherits `replacingDeviceId`; only a
  scan or paste inside the Re-pair sheet (`origin: .inApp`) may replace a device.
- A first pairing is the first LAN request, so iOS shows the Local Network question mid-redeem
  and fails that request. `redeem(patience:)` retries only when no address answered (the code is
  unspent), waits while the app is inactive (the alert is up) and gives the answer a fresh 12 s
  window. A daemon refusal is never retried.
- "Device unreachable" is raised only after 2 minutes of unbroken foreground listening
  (`DeckAlerts.admissible(listenedFor:)`): a heartbeat that is old because the app was suspended
  says nothing about the device. Never from a background wake.
- `DiagLog` (UsageCore `Diagnostics/`) is the on-device debug log behind Settings › Send debug
  log: 800 lines, repeats counted, `Application Support/Logs/debug.log` (excluded from backups).
  Never a token, pairing code or fingerprint; never an alert's body (`kind` + `safeKey(key)`
  only); errors only through `DiagLog.describe` (codes, never messages, and a daemon's code
  only when it matches `[a-z0-9_]{1,40}`, else `unknown`). A device name goes in through
  `DiagLog.name`, an address through `DiagLog.host`: both clean it and mark it, so the export
  (redacted unless the Settings toggle is off) writes `device-N` / `host-N`; every line is
  forced onto one line. The unified system log gets a copy in Debug builds only.
  `PRIVACY.md` and the Settings footer list what an export contains — change them with the log.
- Devices are reached through the ordered `addrs` candidate list (`Endpoints`): last-good first,
  then pairing order; only transport failures move on, an HTTP error from a daemon that answered
  is final. Bonjour is cut.
- Build only on `limits[]`; never read `legacyWindows`. Headline ids `"session"` (5 h) and
  `"weekly_all"` (7 d). `resetsAt` may be null → "resets: unknown". `/v1/tokens?since=today&groupBy=project`
  is the spend endpoint.
- Users are keyed by account **and** organisation (`accountUuid/organizationUuid`); the freshest
  daemon `limitsFetchedAt` wins (never the local clock). Renames (`UserNames`) fall back to the
  daemon's `displayName`, then the e-mail local part.
- Pause `reason` is exactly `"usage-deck:<installId>"`; only our own rules escalate. Session and
  project scopes go to one device; only `all` fans out (to non-dead devices, one retry). A
  project resume fans out to the session rules under it. Hard freeze on a session without a
  hook-registered pid is refused locally.
- Escalation is best-effort (D10): `PauseController.tick()` on every wake fires overdue ones.
- Aging: fresh < 30 s, stale < 120 s, dead ≥ 120 s, always off the phone's clock. Dead disables
  pause controls. Staleness age is always visible.
- A device that has not checked in for a day is **gone** (`Aging.gone`, `DeviceState.gone`):
  `aged(now:)` forgets its readings on that tick and `TeamState` leaves it out of users,
  projects and totals, so nothing of its reaches the home screens, the watch or a widget. It
  stays paired and listed (dead dot, "last heard 2d ago") and returns with its first check-in.
  `fold()` ages every state itself, because a suspended app's clients do not. A snapshot that
  is itself a day old draws no readings on the wrist or a widget (`WatchSnapshot.current(now:)`).
- A limit alert fires once per window: `AlertLedger` keys on the limit's `resetsAt`, survives
  relaunch, and is forgotten when the limit drops under the threshold.
- `BurnHistory` is written from device actors and read on the main actor: every access locks.
- Every user-facing error comes from the daemon envelope: hint → message → per-code default.
- A lost pairing is never "waiting": a 401 sets `repairReason = .tokenRejected`, a pin mismatch
  `.certificateChanged`. The client then stops polling and probes SSE once per `repairProbe`
  (60 s); any answer clears it. Home and the device screen show a `RepairCard` whose Re-pair
  reuses the same record (`beginPairing(replacing:)`), then runs the Connecting overlay.
  `PairingPrompt` words the confirmation: **whenever the invite's fingerprint differs from the
  stored one it says the certificate differs from the one that was paired**, whatever name or
  address the invite carries (those are the invite's own claims; `RepairMatch.sameDevice` only
  chooses between "Replace <old>'s certificate?" and "Replace <old> with <new>?"). A
  same-fingerprint re-pair gets no warning.
  The REPAIR notification comes from the persisted `RepairLedger` (known-good → lost, once,
  1 h cooldown), never the in-memory evaluator; tapping it opens Re-pair. Only a device's
  current `DeviceClient` may update its state (`ingest(_:from:)` checks identity).
- User-facing copy says **"device"**, never "Mac" (the daemon runs on Linux too).
- Paired `DeviceRecord`s live in `UserDefaults` (`DeviceRegistry`), escalations and the alert
  ledger in the App Group suite. `/health.install.listeners` TLS addresses are **merged into**
  a record's `addrs` (appended, up to 16), never replace them — the `.local` name must survive.
- A v1 JSON paste (daemons no longer issue one) is rejected with `PairingInput.legacyMessage`
  and its token is never stored or echoed; the paste field is cleared.
- Frozen alerts never fire for a device's first state after launch (`DeckAlerts`); limit alerts
  do, gated once per window by `AlertLedger`. Quiet hours deliver silently (passive), never drop.
- Watch↔phone: `{refresh}` every 10 s; the phone replies at once with its cached snapshot and
  follows with a fresh one via `updateApplicationContext`. Snapshots go through
  `WatchSnapshotCodec` (< 60 KB, top 20 projects). Complication transfers only on a ≥ 5-point
  move or status change (`ComplicationPolicy`).

## Conventions

- Swift 6 language mode, strict concurrency complete; iOS 18 / watchOS 11 APIs only.
- Tests are Swift Testing (`import Testing`), TDD. HTTP is tested through `StubURLProtocol`
  with a unique host per test, never a real network.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every source file starts with `SPDX-License-Identifier: MIT` and
  `Copyright (c) 2026 Even Seal Productions` (swiftformat's `--header` writes it on Swift files;
  `scripts/check-license-headers.sh` fails a commit and CI without it).
- No `TODO`/`FIXME` in committed code (swiftlint `no_todo`); open work goes in `TODO.md`,
  design-level deferrals in the spec's Deferred list.
- Pushes to `usage-ios` need a GO (the orchestrator session, else the owner). iOS CI publishes to
  TestFlight only — never a GitHub Release.
