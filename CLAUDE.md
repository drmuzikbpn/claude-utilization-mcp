# Usage Deck for iPhone + Apple Watch — working notes

iPhone app (relay + full dashboard) and single-target watchOS app that read Claude account
rate-limit % and local token spend from paired `claude-usage` daemons and pause/resume sessions.
Lives on the orphan branch `usage-ios` of `drmuzikbpn/claude-utilization-mcp`.
**Spec is authoritative:** `docs/superpowers/specs/2026-10-01-usage-ios-design.md` — its
"Audit amendments" override the earlier text where they conflict. Wire contract: daemon spec
§23.44–§23.48 on `main`.

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
TEST_RUNNER_WIDGET_SHOTS_DIR=<dir> xcodebuild -project UsageDeck.xcodeproj -scheme WidgetRender \
  -destination 'platform=iOS Simulator,name=<iPhone>' test          # every widget family → PNG
#   same with -scheme ComplicationRender on a watchOS simulator for the complications
swift scripts/make-icon.swift App/Assets.xcassets/AppIcon.appiconset/icon-1024.png   # app icon
```

## Releases (TestFlight only)

- `.github/workflows/ci.yml`: lint + `swift test` + both builds on every push/PR to `usage-ios`;
  a push to `usage-ios` also archives, exports and uploads to TestFlight. It never creates a
  GitHub Release or tag (the daemon's updater reads `/releases/latest`, §23.17).
- Build number = `GITHUB_RUN_NUMBER * 10 + GITHUB_RUN_ATTEMPT`, which only ever goes up
  (the commit count did not: a squash merge shortened history and build 28 followed 29).
  TestFlight rejects a non-increasing number. Version = `MARKETING_VERSION` (`0.1`).
- Signing: Debug automatic; Release manual — "Apple Distribution: Even Seal Productions LLC
  (YTHBPWUU3Z)" + four App Store profiles named `UsageDeck AppStore`, `UsageWidgets AppStore`,
  `UsageDeckWatch AppStore`, `UsageComplications AppStore` (all carry
  `group.com.evenseal.usagedeck`). CI installs the profiles by name with `ci/asc.py profiles …`.
- Secrets: 1Password `usagedeck/usage-ios-ci` is the source of truth (`.env.tmpl` lists the
  references); GitHub secrets are loaded from it with `op read … | gh secret set NAME` (never as
  an argument). Profiles and the certificate expire 2027-10-02.
- App Store Connect app: "Usage Deck", id 6818383053, SKU `usagedeck-ios`.

lefthook is installed (`lefthook install`); the git hooks dir is shared with the other worktrees
of this repo and runs whichever `lefthook.yml` the committing worktree has. Never `--no-verify`.

## Layout

| Path | What lives there |
| --- | --- |
| `Packages/UsageCore/` | SwiftPM, no UI. `Daemon/` (DTOs, `DaemonAPI`, `EventStream`, `Endpoints`, errors), `Net/PinnedTrust`, `Pairing/`, `Device/` (`DeviceReducer` + `DeviceClient` actor), `Model/` (`TeamState`, `Aging`, `BurnHistory`, `Version`, `Highest`, `SetupCheck`, `UserNames`), `Pause/`, `Alerts/`, `Format/`, `Watch/` (`WatchSnapshot`, wire messages), `Storage/TokenStore`. Linked by all four targets. |
| `App/` | iOS app `com.evenseal.usagedeck` (iOS 18). `Store/` (`DeckStore` — the one `@Observable` app model; `WatchBridge`, `AlertNotifier`, `BackgroundRefresh`, Debug-only `DemoData`), `UI/` (Ledger, WideDock, Project/Projects, Device, Settings, Pairing, shared `Components/`), `Theme/` (palette, `DeckBackdrop` aurora tinted by the worst limit, `deckCard`, zoom sources; bundled OFL fonts in `Resources/Fonts`). The app also compiles `SharedUI/Theme.swift`, `RingGauge.swift` and `Materials.swift` (`deckGlass`: Liquid Glass on iOS/watchOS 26, frosted material before) so phone and watch draw the same rings and glass. Home lists rank by live rate (`ActivityOrder`, 5-minute `BurnHistory.rateWindow`), not by tokens today. App logic that can be tested without UIKit lives in UsageCore `Deck/` (`DeckSettings`, `DeviceRegistry`, `InstallID`, `AddressMerge`, `PairingInput`, `PauseVisuals`, `HomeEmpty`, `DeckAlerts`, `SnapshotDiff`, `FirstLoad` — when a freshly paired device's first refresh has landed, so the "Connecting…" overlay never hands over to rows of "unknown"; `ConnectTracker` — one attempt at a time, foreground-only timeout; `RepairNotice` — the copy for a lost pairing). |
| `AppUITests/` | XCUITest smoke test: launches with `-UsageDeckDemo` (Debug only, made-up devices, no daemon) and walks every screen. |
| `Watch/` | watchOS app `com.evenseal.usagedeck.watchkitapp` (watchOS 11), single target. |
| `Widgets/` | iOS widget extension `.widgets`. |
| `Complications/` | watchOS widget extension `.watchkitapp.complications`. |
| `project.yml` | XcodeGen. App Group `group.com.evenseal.usagedeck`, URL scheme `usagedeck`, Swift 6 strict concurrency. |

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
- **Pinning is the whole of trust.** Every device URL is `https://`; `PinnedTrust` accepts a
  server trust iff sha256(P-256 SPKI header ‖ `SecKeyCopyExternalRepresentation`) equals the
  paired `fp`, and refuses every other challenge. Same pin on every candidate address. No
  `NSAllowsArbitraryLoads`, ever.
- Pairing link (`usagedeck://pair?v=2&name&addrs&port&fp&code`) carries a one-time code, never the
  bearer; `PairingClient` redeems it with `POST /v1/pair` (the one bearer-less endpoint).
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
- A limit alert fires once per window: `AlertLedger` keys on the limit's `resetsAt`, survives
  relaunch, and is forgotten when the limit drops under the threshold.
- `BurnHistory` is written from device actors and read on the main actor: every access locks.
- Every user-facing error comes from the daemon envelope: hint → message → per-code default.
- A lost pairing is never "waiting": a 401 sets `repairReason = .tokenRejected`, a pin mismatch
  `.certificateChanged`. The client then stops polling and probes SSE once per `repairProbe`
  (60 s); any answer clears it. Home and the device screen show a `RepairCard` whose Re-pair
  reuses the same record (`beginPairing(replacing:)`), then runs the Connecting overlay.
- User-facing copy says **"device"**, never "Mac" (the daemon runs on Linux too).
- Paired `DeviceRecord`s live in `UserDefaults` (`DeviceRegistry`), escalations and the alert
  ledger in the App Group suite. `/health.install.listeners` TLS addresses are **merged into**
  a record's `addrs` (appended), never replace them — the `.local` name must survive.
- A v1 JSON paste is rejected with the Android message and its token is never stored or echoed;
  the paste field is cleared.
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
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- No `TODO`/`FIXME` in committed code (swiftlint `no_todo`); open work goes in `TODO.md`,
  design-level deferrals in the spec's Deferred list.
- Pushes to `usage-ios` need a GO (the orchestrator session, else Alan). iOS CI publishes to
  TestFlight only — never a GitHub Release.
