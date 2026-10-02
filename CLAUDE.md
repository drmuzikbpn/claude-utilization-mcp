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
xcodebuild -project UsageDeck.xcodeproj -scheme UsageDeckWatch \
  -destination 'generic/platform=watchOS Simulator' build
swiftformat . && swiftlint lint --strict        # lefthook runs both + `swift build` on pre-commit
```

lefthook is installed (`lefthook install`); the git hooks dir is shared with the other worktrees
of this repo and runs whichever `lefthook.yml` the committing worktree has. Never `--no-verify`.

## Layout

| Path | What lives there |
| --- | --- |
| `Packages/UsageCore/` | SwiftPM, no UI. `Daemon/` (DTOs, `DaemonAPI`, `EventStream`, `Endpoints`, errors), `Net/PinnedTrust`, `Pairing/`, `Device/` (`DeviceReducer` + `DeviceClient` actor), `Model/` (`TeamState`, `Aging`, `BurnHistory`, `Version`, `Highest`, `SetupCheck`, `UserNames`), `Pause/`, `Alerts/`, `Format/`, `Watch/` (`WatchSnapshot`, wire messages), `Storage/TokenStore`. Linked by all four targets. |
| `App/` | iOS app `com.evenseal.usagedeck` (iOS 18). |
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
- User-facing copy says **"device"**, never "Mac" (the daemon runs on Linux too).
- Watch↔phone: `{refresh}` every 10 s; the phone replies at once with its cached snapshot and
  follows with a fresh one via `updateApplicationContext`. Snapshots go through
  `WatchSnapshotCodec` (< 60 KB, top 20 projects). Complication transfers only on a ≥ 5-point
  move or status change (`ComplicationPolicy`).

## Conventions

- Swift 6 language mode, strict concurrency complete; iOS 18 / watchOS 11 APIs only.
- Tests are Swift Testing (`import Testing`), TDD. HTTP is tested through `StubURLProtocol`
  with a unique host per test, never a real network.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- No `TODO`/`FIXME` in committed code (swiftlint `no_todo`); deferred work goes in the spec's
  Deferred list.
- Pushes to `usage-ios` need a GO (the orchestrator session, else Alan). iOS CI publishes to
  TestFlight only — never a GitHub Release.
