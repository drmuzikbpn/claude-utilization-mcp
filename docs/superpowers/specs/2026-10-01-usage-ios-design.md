# Usage Deck for iPhone + Apple Watch — design

Copied on 2026-10-01 from the approved plan (sections reproduced verbatim, so wording that
predates the audit — Bonjour, `{refresh}` every 5 s, a token in the pairing QR — is superseded by
**Audit amendments** below, which win wherever they conflict). The daemon side of the wire is
specified in the daemon's own spec (`main`, §23.44–§23.48) and `docs/api.md`.

## Contents

- [Context](#context)
- [Decisions](#decisions-from-brainstorming-2026-10-01)
- [Part C — `usage-ios` branch](#part-c--usage-ios-branch)
- [Audit amendments](#audit-amendments-fable-audit-2026-10-01--these-override-the-text-above-where-they-conflict)
- [Phases](#phases-each-ends-green-committed-pushes-per-push-protocol-below)
- [Deferred](#deferred)

## Context

Alan's Android kiosk (`usage-deck` branch → renamed `usage-android`) shows Claude account
rate-limit % and local token spend from `claude-usage` daemons and pauses sessions. He wants the
same on his wrist — specifically the **landscape left rail** (`ui/widedock/WideDockScreen.kt`
`Rail`: per-account 5 h / 7 d rings with countdown + reset time, account pager, Pause all
(tap soft / hold hard), Projects, `team today · N live` footer) — spread across multiple watch
screens, plus project drill-in with pause. An iPhone companion app is required (watchOS has no
Tailscale and must not hold bearer tokens) and will also carry the **full Android home**. Friends
will test via **TestFlight**, so setup must be easy and **independent of Tailscale**: same-Wi-Fi
out of the box (HTTPS + pinned self-signed cert + Bonjour), Tailscale/VPN optional for away.
Pairing: the daemon CLI opens a self-generated browser QR page; the iPhone Camera opens the app.

Devices: iPhone 14 Pro Max (iOS 26.6.2), Apple Watch Series 10 (watchOS 26).
**Minimum: iOS 18, watchOS 11.** Approach chosen: **native Swift port** of the Kotlin `core/`
(not KMP).

## Decisions (from brainstorming, 2026-10-01)

| # | Decision |
|---|---|
| D1 | iPhone companion owns pairings, tokens (Keychain, ThisDeviceOnly, never synced), daemon I/O; watch gets data only via WatchConnectivity. Watch never sees a token. |
| D2 | iPhone app = relay **and** full Android home (portrait Ledger + landscape wide dock). |
| D3 | Watch Projects → list → project detail with sessions + pause, condensed to fit. |
| D4 | Background freshness best-effort (BGAppRefresh); live while either app is open. **No push relay in v1** (todo). |
| D5 | TestFlight (internal + external testers). App name avoids "Claude". |
| D6 | Code on new orphan branch **`usage-ios`**; rename **`usage-deck` → `usage-android`**. `deck-` release tags unchanged. |
| D7 | Pause grammar: tap = soft; hold → **"Freeze?" confirm** → hard; tap on paused = resume. Same on iPhone. |
| D8 | Threshold alerts in v1 (once-per-window, deck's `AlertLedger` semantics), iPhone local notifications mirrored to watch. |
| D9 | Complications + iPhone home/lock-screen widgets, per-widget account choice, default **"Highest"** (account closest to a limit, initial-labelled). |
| D10 | Escalation (soft→hard after 90 s) is best-effort: runs while iPhone/watch app awake; overdue timers fire on next wake. Daemon-side `escalateAfter` = todo. |
| D11 | Tailscale-independent: daemon `lan` listener, HTTPS with self-signed cert, fingerprint pinned via pairing link, Bonjour discovery. Tailscale optional. |
| D12 | Easy pairing: `claude-usage pair` (also offered at end of `install`) serves a one-time loopback page with an SVG QR of `usagedeck://pair?...`; iPhone Camera → "Open in Usage Deck". |
| D13 | App empty state: "Get the Mac app" → `https://github.com/drmuzikbpn/claude-utilization-mcp`, Share sheet with install commands. |
| D14 | Daemon adds `/health.install` (hooks / statusline / MCP registered, bound listeners) so the app's setup check is definitive. |
| D15 | User-facing copy says "device", not "Mac" (daemon runs on Linux too). Empty state: "No paired devices — pair one in the iPhone app". |

**Deferred todo (record in spec §Deferred):** push relay (APNs) for real-time alerts/complications;
daemon-side `escalateAfter`; Android deck accepting the v2 pairing link + HTTPS; remote access
without a VPN.

## Part C — `usage-ios` branch

### Layout
```
project.yml                 XcodeGen (Xcode project not committed, regenerated)
Packages/UsageCore/         SwiftPM: Sources/UsageCore, Tests/UsageCoreTests (+ Fixtures/ copied from usage-android core/src/test/resources/fixtures)
App/                        iOS app "Usage Deck"     com.evenseal.usagedeck
Watch/                      watchOS app (single-target) com.evenseal.usagedeck.watchkitapp
Widgets/                    iOS widget extension      .widgets
Complications/              watchOS widget extension  .watchkitapp.complications
Shared/                     WatchSnapshot + messages, theme tokens, Format (compiled into all targets)
.github/workflows/ci.yml    on: push [usage-ios], pull_request
lefthook.yml                swiftlint + swiftformat --lint + `swift build` (UsageCore)
CLAUDE.md, README.md, PRIVACY.md, docs/superpowers/specs/2026-10-01-usage-ios-design.md, docs/superpowers/plans/…
```
App Group `group.com.evenseal.usagedeck`; URL scheme `usagedeck`; Swift 6, strict concurrency.

### UsageCore — port map (Kotlin source on `usage-android` → Swift)
| Kotlin | Swift |
|---|---|
| `core/daemon/Dto.kt`, `Mapping.kt`, `Errors.kt` | `DTO.swift`, `Mapping.swift`, `DaemonError.swift` (envelope hint→message→default) |
| `core/daemon/DaemonApi.kt` | `DaemonAPI.swift` (URLSession, async/await, ETag on `/v1/sessions`) |
| `core/daemon/EventSource.kt`, `SseEvents.kt` | `EventStream.swift` (`URLSession.bytes` SSE parser) |
| `core/daemon/MachineClient.kt` | `DeviceClient.swift` (actor; REST bootstrap + SSE when foreground, poll fallback) |
| `core/model/TeamState.kt`, `Types.kt`, `Aging.kt`, `BurnHistory.kt` | same names; users keyed `accountUuid/organizationUuid`; aging 30 s / 120 s |
| `core/pause/PauseController.kt`, `PauseTarget.kt`, `EscalationStore.kt` | same; reason `usage-deck:<installId>`; project resume fans out to session rules (deck gotcha) |
| `core/alerts/AlertEvaluator.kt` + `app/alerts/AlertLedger.kt` | `AlertEvaluator.swift` + `AlertLedger.swift` (UserDefaults; key = limit `resetsAt`) |
| `app/pairing/PairingPayload.kt` | `PairingLink.swift` (v2 URL; v1 JSON paste accepted) |
| `app/ui/components/Format.kt` (`resetCountdown`, `resetAt`, `tokens`) | `Shared/Format.swift` |
New: `PinnedTrust.swift` — `URLSessionDelegate` that accepts the server trust **iff** SPKI SHA-256
== stored fingerprint; everything else rejected. Build only on `limits[]`; never `legacyWindows`.

### iPhone app
- `DeckStore` (@Observable, @MainActor) owns `DeviceClient`s, `TeamState`, `PauseController`,
  escalations (persisted `scope, deviceId, fireAt`), alerts.
- Screens (port of `usage-android` `ui/`): Ledger (portrait), WideDock (landscape), Project
  (Swift Charts burn chart), Projects, Device detail (setup checklist + Re-check / Re-pair / Remove),
  Pairing (Camera deep link via `onOpenURL`, in-app `DataScannerViewController` QR, paste,
  "Get the Mac app", Share install commands), Settings (thresholds, escalation, quiet hours,
  renames, 24 h). Dark theme, colours/fonts from deck spec §11.6 (Barlow Condensed / IBM Plex,
  bundled OFL fonts), tabular numerals.
- Setup check from `/health`: reachable, `version ≥ MIN_DAEMON` (the release shipping Part A),
  signed in, `stats.spendReady`, a fresh limit row, `install.{hooks,statusline,mcp}`; each failing
  row shows its fix command.
- Local Network usage description + `NSBonjourServices = [_claude-usage._tcp]`; Bonjour
  re-resolves a device whose IP changed (match by `fp` TXT prefix, verify full pin on connect).
- `WatchBridge`: `WCSession` — pushes `WatchSnapshot` via `updateApplicationContext` (trimmed
  < 60 KB: accounts, top 20 projects, their live sessions, pause states, escalations, staleness);
  answers watch `sendMessage` `{refresh}` (REST fetch, reply snapshot) and `{pause|resume, deviceId, scope, mode}`.
- Background: `BGAppRefreshTask` → fetch summaries → alerts → write App-Group snapshot →
  `WidgetCenter.reloadAllTimelines()` → `transferCurrentComplicationUserInfo` only when a headline %
  changed.

### Watch app (screens per approved §2)
Vertical `TabView(.verticalPage)`: one page per account (name, 5 h big ring + 7 d small ring,
countdown + reset time, stale fade/dot) → Actions page (Pause all / Resume all, Projects, footer,
pending escalation countdown). `NavigationStack` → Projects list → Project detail (3 figures,
5 h sparkline, session rows with pause, Pause project). States: iPhone unreachable banner +
disabled controls; "No paired devices — pair one in the iPhone app"; per-device "Needs re-pair";
optimistic flip + haptics; AOD shows rings/percent only. Polls `{refresh}` every 5 s while active.

### Widgets / complications
WidgetKit `AppIntentConfiguration` with `AccountEntity` (`Highest` + each account). Families:
watch `accessoryCircular` (5 h ring), `accessoryRectangular` (5 h / 7 d + countdown),
`accessoryCorner`, `accessoryInline`; iPhone `systemSmall`, `systemMedium`, lock-screen
accessories. Timeline from App-Group snapshot; entries stepped so countdowns stay correct.

### CI / TestFlight
- macOS runner: `xcodegen`, `swift test` (UsageCore), `xcodebuild test` (iOS sim + watch sim),
  **contract job**: checkout `main`, `npm ci && npm run build`, run `node bin/claude-usage serve`
  with `XDG_CONFIG_HOME` temp + `lan`/TLS bound to loopback alias, run UsageCore contract tests
  (pairing link, pinning, SSE, pause/resume round-trip).
- Release on push to `usage-ios`: archive + upload via App Store Connect API key
  (`-allowProvisioningUpdates`). Secrets: **1Password first** (item `usage-ios-ci` in the project
  vault: key id, issuer id, `.p8`), then GitHub secrets. `CFBundleShortVersionString = 0.MINOR`,
  build = `GITHUB_RUN_NUMBER * 10 + GITHUB_RUN_ATTEMPT` (monotonic; the commit count was not).
- External testing needs Beta App Review, feedback email, `PRIVACY.md` URL on GitHub (no data
  collected; talks only to your own devices). Check "Usage Deck" name availability in App Store Connect.

---

## Audit amendments (Fable audit, 2026-10-01) — these override the text above where they conflict

- **A1 TLS addressing:** TLS is a per-listener flag. Rule: every bound address keeps plain HTTP on
  `port` (A7 — backward compatible, incl. deck emulator on LAN literal); every *non-loopback* address
  additionally gets HTTPS on `tlsPort`; config `tls.loopback: true` (tests only) adds HTTPS on
  127.0.0.1 so the contract job runs on 127.0.0.1 without aliases.
- **A2 candidates:** pairing link carries `addrs=` ordered list (LAN IP, `<LocalHostName>.local`,
  tailnet IP if bound); app also refreshes the list from `/health.install.listeners`; `DeviceClient`
  tries in order over HTTPS (same pin on every address).
- **A3 IP changes:** generalise §23.21 retry/`reload()` from `tailscale` to any keyword entry, plus a
  30 s `os.networkInterfaces()` diff (no subprocess) that triggers `reload()` when `lan` moves.
  `lan` = first non-internal RFC1918 IPv4 on an interface not matching
  `^(bridge|vmnet|docker|utun|awdl|llw|lo)`.
- **A4 server shape:** `BoundAddress` gains `{ tls, port }`; `rebuildPolicy` includes `tlsPort`;
  `daemon.json` records `tlsPort`; listeners map owns TLS servers so unbind/SIGHUP/Host all apply.
- **A5:** `configure pairing` output is unchanged (QR = v1 JSON; new keys allowed). Only
  `claude-usage pair` renders the v2 link.
- **A6 rename extras:** deck `ci.yml:31` release gate `refs/heads/usage-android`; README 103-104,
  CONTRIBUTING 3/8-11, SECURITY 12; local clones `git branch -u origin/usage-android`.
- **A8:** `install` block cached once (shared 60 s), never throws, booleans + `{addr,port,tls}` only;
  `statusline` reports `ours | other-includes-us | other | none`; `mcp` reported best-effort
  (`unknown` shown neutral, not red). Embedded in SSE snapshot via `healthBody` — same cache.
- **A9:** cert key is generated once and kept; cert re-issued with same key is pin-stable.
  `rotate-cert` deferred (delete files + restart = new key ⇒ re-pair).
- **Bonjour cut (audit D1):** no dns-sd/avahi child. `.local` hostname rides in `addrs`; §23.46
  Host policy accepts `scutil --get LocalHostName`.local (darwin) / `os.hostname()`.local.
- **Pair page hardening:** 127.0.0.1 only, reject non-loopback `remoteAddress`, random path served
  once, 404 everything else, `Cache-Control: no-store`, token only inside SVG, copy adds "if shown on
  a call, run `claude-usage configure rotate-token`". Vendor the 10 QRCode files (pinned) instead of
  deep-importing `qrcode-terminal/vendor`.
- **Releases:** iOS CI creates **no GitHub Release** (TestFlight only); also add `ios-` to
  `FOREIGN_TAG_PREFIXES` (src/update/check.ts:71) as belt-and-braces.
- **Version:** port deck `core/update/Version.kt` for `MIN_DAEMON` (`0.1.N+sha`).
- **Setup check:** no fresh limits on a new install ⇒ neutral "open a Claude Code session", not red.
- **B1 pinning:** hash `P-256 SPKI header (3059301306072a8648ce3d020106082a8648ce3d030107034200) ‖
  SecKeyCopyExternalRepresentation`; shared throwaway `cert.der` + expected-fp fixture in both repos.
- **B2:** complication transfer only on ≥5-pt change or status transition, check
  `remainingComplicationUserInfoTransfers`; watch writes its own App-Group snapshot +
  `reloadAllTimelines()` in `didReceiveUserInfo`.
- **B3 / D16 — one-time pairing code (decided):** the QR/link carries `addrs`, `port`, `fp`, `name`
  and a single-use pairing code (≥ 128-bit, expires 5 min, held only in daemon memory) — **never the
  bearer**. App redeems via `POST /v1/pair { code }` over HTTPS → `{ token }`; code burned on first
  use or expiry; 5 failed attempts per minute per source ⇒ 429; constant-time compare. The one
  documented exception to "every mutating endpoint requires the bearer" (spec §23.48 + CLAUDE.md).
  `claude-usage pair` mints the code by calling the daemon over loopback with the bearer
  (`POST /v1/pair/code`). Camera link and in-app scanner are then equally safe.
- **B4:** watch `{refresh}` every 10 s; reply immediately with cached snapshot, fresh one follows via
  `updateApplicationContext`.
- **B5:** Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; staleness age always visible;
  verification wording "alert arrives when the iPhone gets background time or an app is open".
- **Docs:** also `docs/security.md` (LAN posture, hostname is visible via mDNS), `docs/api.md`,
  deck `docs/smoke-test.md`. `install --yes` does **not** enable `lan` unless `--lan` is passed;
  interactive install prompts with default yes.
- **iOS minors:** `ITSAppUsesNonExemptEncryption=NO`; gate DataScanner on `isSupported`; pin Xcode 26
  runner; Distribution .p12 fallback in the 1Password item; no `NSAllowsArbitraryLoads`.
  PRIVACY.md notes TestFlight sends crash/usage data to Apple.
- **Phase 0 spike adds:** XcodeGen watch+widgets generation, SPKI hash agreement, WC reply latency,
  `lan` rebind on Wi-Fi change.
- Part B's `main` edits ride Phase 1's PR.

## Phases (each ends green, committed; pushes per push protocol below)

0. **Spike (throwaway):** iOS 18 sim + Alan's iPhone reach a Node HTTPS server with self-signed cert
   on LAN via pinned delegate; observe Local Network prompt; Camera opens `usagedeck://` link.
1. **Daemon Part A** (§23.44–48), TDD, PR to `main`, release.
2. **Branch rename Part B** (after Alan approves the rename + ruleset change).
3. **`usage-ios` scaffold + UsageCore** port with fixtures + contract tests; iPhone pairing + setup check.
4. **Watch app** + WatchBridge.
5. **iPhone full home** (Ledger, WideDock, Project, Projects, Device, Settings).
6. **Alerts, widgets, complications, background refresh.**
7. **CI → TestFlight**, internal then external group; docs (README, CLAUDE.md, PRIVACY.md).

## Deferred

Not in v1; recorded here so nothing is lost (and so code never carries TODOs):

- Push relay (APNs) for real-time alerts and complications.
- Daemon-side `escalateAfter`, so soft→hard escalation does not depend on an awake app.
- Android deck accepting the v2 pairing link and HTTPS.
- Remote access without a VPN.
