# Usage Deck — Nexus 5X kiosk dashboard for claude-usage daemons

**Date:** 2026-09-13
**Status:** approved design, audited 2026-09-13 (Sonnet audit, 22 findings folded in), pre-implementation
**Companion spec:** `~/code/claude-utilization-mcp/docs/superpowers/specs/2026-09-13-claude-usage-design.md`
(the daemon; Part II §15–22 defines every endpoint this app consumes)
**Device:** LG Nexus 5X (`bullhead`), serial `00d659a3e158b06c`, 1080×1920 5.2" LCD, Snapdragon 808
**Mockups:** https://claude.ai/code/artifact/15c25174-e96e-4521-b3b1-761429fcf63d (Ledger, Wide dock, Ledger drill-in + tiles)

## 1. Purpose

A single-purpose Android device that shows Claude Code utilization for a two-seat team in
real time and lets the owner pause and resume Claude Code sessions on any paired machine.
It runs as the device's launcher in lock-task mode on LineageOS, wifi only, reaching each
machine's `claude-usage` daemon over Tailscale.

The app is called **Usage Deck** (package `com.evenseal.usagedeck`); rename freely before
the first release.

## 2. Decisions made during brainstorming

| Topic | Decision |
| --- | --- |
| OS approach | LineageOS 17.1 (Android 10) for `bullhead`, no Google apps, app installed as **Device Owner**, lock-task kiosk |
| Network | Wifi only. Tailscale on phone and every machine; daemons bind their tailnet address |
| Reach | Every machine in the system runs the same `claude-usage` daemon; phone pairs to N machines |
| Pause | Two-stage: **soft** (daemon hooks hold at next boundary) then **hard** (SIGSTOP) via tap-and-hold or timeout |
| Updates | Every green push to `main` publishes a release; daemons and the phone self-update from it |
| Physical use | Both: dock mode on power, pick-up mode on battery; orientation-aware layout |
| Alerts | Yes, in both modes, with quiet hours |
| Home (portrait) | **Ledger**: both users' bars, sessions list with sparklines |
| Landscape | **Wide dock**: big numbers rail + ledger pane |
| Drill-in | Ledger drill-in plus the three summary tiles (today / rate / share of 5h) |
| Stack | Kotlin, Jetpack Compose, single Gradle module, minSdk 29, targetSdk 29 |

## 3. Architecture

```
┌──────────── Usage Deck (Android, Device Owner, lock task) ─────────────┐
│ kiosk/      launcher + LockTask + exit PIN + dock/battery mode          │
│ wifi/       Device-Owner WifiManager: scan, connect, saved, portal      │
│ pairing/    QR scan → MachineConfig (EncryptedSharedPreferences)        │
│ daemon/     per-machine client: SSE stream, REST fallback, auth, aging   │
│ model/      Machine, User, Project (git-common-dir), Session, PauseRule │
│ pause/      state machine: soft → escalate → hard; optimistic UI        │
│ alerts/     thresholds, freeze, unreachable → notifications + haptics   │
│ update/     GitHub release poll → sha256 → PackageInstaller (silent)    │
│ ui/         Ledger, WideDock, ProjectDetail, Machine, Wifi, Settings    │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ HTTPS? no — HTTP over tailnet, Bearer token
              ┌─────────────┴──────────────┐
   alan-mbp: claude-usage daemon   sam-studio: claude-usage daemon
   100.x:47291                      100.x:47291
```

One process, one Activity, Compose navigation. A foreground `Service` keeps the SSE
connections and alert evaluation alive while the screen is off in battery mode.

## 4. Device and OS setup (documented in `docs/device-setup.md`)

1. Enable OEM unlock + USB debugging on stock; `fastboot flashing unlock`.
2. Flash LineageOS 17.1 for `bullhead` + its recovery. **No GApps.** Skip account setup.
3. `adb install` Usage Deck, then `adb shell dpm set-device-owner com.evenseal.usagedeck/.kiosk.DeviceAdminReceiver`
   (must happen before any account exists on the device).
4. Install Tailscale from its APK; log in; approve the node in the tailnet admin.
5. Open Usage Deck once: it sets itself as default launcher, whitelists `[usagedeck, tailscale]`
   for lock task, disables the keyguard, sets stay-awake-on-power, and starts lock task.
6. Pair each machine by QR (§6.3).

Hard preconditions the setup doc checks off explicitly: **never set a screen lock** on the
device (`setKeyguardDisabled` silently no-ops once a secure keyguard exists); Tailscale is
configured **point-to-point only, never as an exit node** (so GitHub update polling does not
depend on tailnet health); each daemon's `config.bind` includes `"tailscale"` (else every
phone request gets `421`) — verified in step 6 by the pairing health check.

The app also, as Device Owner: adds itself to the battery-optimization whitelist (Doze
exemption) so the SSE stream survives screen-off in battery mode, and suppresses the status
and navigation bars in lock task.

Maintenance exit: long-press the top-left corner 3 s → PIN → lock task stops for 10 min. The
re-arm is an `AlarmManager` alarm owned by the foreground service that calls `startLockTask()`
regardless of which app is in front; a reboot inside the window boots locked. PIN: 6 digits,
stored as salted SHA-256 in `EncryptedSharedPreferences`, 5 wrong attempts → 5 min lockout
doubling each round; forgotten PIN recovery is `adb shell` as documented in
`docs/device-setup.md` (USB debugging stays enabled on this device).

Charge cap: **not available in v1.** Writing battery sysfs needs root; Device Owner does not
grant it. The setup doc says so plainly. Thermal: if battery temperature > 42 °C the app dims
to 30 % and drops sparkline redraws to every 10 s.

## 5. Modes

| | Dock (on power) | Battery |
| --- | --- | --- |
| Screen | Always on; dim to 35 % during quiet hours; 1 px layout shift every 60 s | Normal 60 s timeout; lockscreen headline card (both 5 h %) |
| Layout | Follows orientation sensor: portrait → Ledger, landscape → Wide dock | Same |
| Refresh | SSE live | SSE live while on; foreground service keeps stream for alerts |
| Alerts | Full-screen overlay 8 s + haptic | Heads-up notification + haptic |

Quiet hours (default 23:00–07:00) silence haptics and dim; visuals still update.

## 6. Connectivity

### 6.1 Wifi (`wifi/`)
- Device Owner grants unrestricted `WifiManager` on Android 10: `startScan`, `getScanResults`,
  `addNetwork`/`enableNetwork`, `getConfiguredNetworks`, `removeNetwork`.
- Wifi screen: current SSID + RSSI + IP, scan results sorted by RSSI (dedup by SSID, show
  security type) delivered via `SCAN_RESULTS_AVAILABLE_ACTION` — Android 9+ throttles
  `startScan()` to ~4 per 2 min even for privileged callers, so the list shows its age and a
  manual rescan is rate-limited in the UI, saved networks with forget, "Open captive portal" launches a minimal
  in-app WebView (whitelisted in lock task) and returns on close.
- Status chip on every screen: SSID and signal bars; red when disconnected. Tap → Wifi screen.
- Enterprise (EAP) networks are out of v1; WPA2/WPA3-personal and open only.

### 6.2 Tailnet reachability
- The app does not manage the VPN. Per machine it tracks `reachable | unauthorized |
  unreachable` from the SSE connection state and the last heartbeat.
- If **all** machines are unreachable and the wifi is up, show a "Tailscale may be down" row
  with a button that launches the Tailscale app.

### 6.3 Pairing (`pairing/`)
- Scan the QR printed by `claude-usage configure pairing`: `{ v, name, addr, port, token }`.
  Reject `v != 1`. Store as `MachineConfig` in `EncryptedSharedPreferences`. The pairing
  screen says the QR is a live credential: scan it off-camera, and run
  `claude-usage configure rotate-token` if it was ever exposed.
- Immediately `GET /health` with the token: success → machine appears; 401 → "token rejected,
  re-run pairing on the Mac"; timeout → saved anyway, shown unreachable.
- Machine detail screen: name, user email, version, update state, last heartbeat, unpair
  (swipe or button, confirm).
- No limit on machine count; UI is designed for 2–3.

## 7. Daemon client (`daemon/`)

- One `MachineClient` per paired machine. Connection: `GET /v1/events` with
  `Authorization: Bearer`, using OkHttp SSE. On every connect the `snapshot` event replaces
  that machine's state wholesale. Reconnect with backoff 3 s → 30 s.
- Events applied: `limits`, `spend` (machine-wide today total + delta), `session`
  (start/end/update), `pause` (rules + affected), `update`, `heartbeat`.
- **Limits** arrive as the daemon's normalized array (§23 of the daemon spec):
  `[{ id, kind, group, percent, severity, resetsAt|null, scope, isActive }]`, with status in
  `summary.status.byId`. The phone builds only on this array; `legacyWindows` is ignored.
  `id == "session"` is the 5 h headline, `id == "weekly_all"` the 7 d headline; scoped entries
  (`weekly_scoped:<model>`) render as small chips. `resetsAt == null` → "resets: unknown".
- **Fallback polling** when SSE has failed twice in a row: `GET /v1/summary` (no ETag; full
  body) and `GET /v1/sessions` with `If-None-Match: W/"<rev>"` every 2 s (screen on) / 30 s
  (dimmed or off). Return to SSE on the next backoff tick.
- **Totals reconciliation:** the machine's today total is seeded from `snapshot.summary.today`
  and then **replaced** by each `spend.today` (authoritative); `spend.delta` is used only to
  advance the machine-wide burn history. Per-project and per-session live burn come from
  cumulative `session.update.tokens`, never from `spend`. Idle-project and per-project today
  totals come from `GET /v1/tokens?groupBy=project&since=today` every 30 s (`key` is the
  opaque projects-dir name, `label` is the cwd; join to live sessions by cwd).
- **Burn history:** per session, per project and per machine, a ring buffer of (timestamp,
  cumulative tokens); rate = tokens/min over a 60 s window; sparklines cover 30 min, project
  chart covers 5 h. Lost on app restart (v1).
- **Aging:** `lastHeartbeatAt` drives `fresh (<30 s) | stale (<2 min) | dead`. Stale fades
  figures to 55 %; dead greys the machine dot and disables its pause controls.
- Error envelope `{ error: { code, message, hint? } }`: snackbar shows `hint` if present, else
  `message`, else a per-code default string (so a bare `unauthorized` still reads as
  "token rejected, re-run pairing on the Mac").
- All calls are `application/json`, no CORS, no cookies, timestamps parsed as ISO-8601 UTC.

## 8. Model (`model/`)

```
Machine { id, name, addr, port, token, user: User?, version, update: UpdateState,
          health: fresh|stale|dead, limits: [Limit], limitsFetchedAt }
User     { emailAddress, accountUuid, displayName }
Limit    { id, kind, group, percent, severity, resetsAt?, scope?, isActive, status: ok|warn|critical }
Project  { key: gitCommonDir ?: cwd, name, machineId, sessions: [Session], todayTokens }
Session  { sessionId, pid?, alive, discovered: hook|transcript, cwd, worktree?, model, startedAt,
           lastActivityAt, tokens {input, output, cacheCreate, cacheRead, messages},
           pause: PauseState?, lastTool: {name, at}? }
PauseRule{ id, scope: all | project:<key> | session:<id>, mode: soft|hard, reason, createdAt, createdBy }
```
- Projects are grouped by `project.gitCommonDir` from the daemon, so worktrees of one repo
  roll up. Sessions with `discovered == "transcript"` (back-filled, no trusted pid) show a
  "no pid" tag and hide hard pause (daemon returns 409 anyway).
- Team view derives from the union of machines: limits shown **per user**, spend summed. When
  one user is logged into two paired machines, both report the same account-wide limits; the
  copy with the freshest `limitsFetchedAt` wins, and the user block lists both machines.
- `lastTool` is populated only if the daemon emits it (requested in §17); absent → the row
  shows `lastActivityAt` instead.

## 9. Pause (`pause/`)

- **Gesture grammar** (fixed across all screens): tap = soft pause; tap-and-hold 600 ms with
  haptic = hard freeze; tap on a paused control = resume. Red styling appears only on
  hold-actions.
- Scopes: session row → `session:<id>`; project header / drill-in → `project:<gitCommonDir>`;
  Pause-all bar → `all`. Sent as `POST /v1/pause { scope, mode, reason: "usage-deck:<installId>" }`,
  resume as `POST /v1/resume { scope }`. `installId` is a random UUID generated on first run.
- **Session and project scopes are single-machine**: they go only to the machine that owns
  the session or project (no cross-machine name matching; a same-named repo on the teammate's
  Mac is a different project). **`all` fans out** to every reachable machine. Each machine's
  result shows on the Pause-all bar: a failed or timed-out machine gets one automatic retry
  after 2 s, then a red dot on the bar and a snackbar naming it; successes are not rolled back.
- **Escalation:** a soft pause **this phone** started (matched by `rule.reason ==
  "usage-deck:<installId>"`) carries a timer (default 90 s, configurable 30 s–10 min, or off).
  When it fires the app issues the hard request for the same scope. Rows show the countdown.
  Cancelled by resume (from anywhere, observed via the `pause` event), by the session ending,
  or by the rule disappearing. Soft pauses created elsewhere (CLI, another phone) never
  escalate. Pending escalations are **persisted** (`scope, machineId, fireAt`) and restored
  on process start; a timer that already expired while the app was down fires immediately.
- **Optimistic UI:** the control flips immediately with a spinner; the `pause` SSE event or
  the POST response confirms; a 409/410 reverts and shows the hint.
- Idempotent by design: repeating a pause returns the existing rule; repeating a resume
  returns empty arrays. The app treats both as success.
- Update-deferred indicator: a machine whose `update.state == deferred` shows "update
  waiting on frozen session" in machine detail and on frozen rows.

## 10. Alerts (`alerts/`)

| Trigger | Condition | Pattern |
| --- | --- | --- |
| warn | any user's window crosses ≥ 80 % (configurable) | 1 short buzz |
| critical | ≥ 95 % | 3 short buzzes, repeat every 10 min while critical |
| frozen | a session enters hard freeze (from anywhere) | 1 long buzz |
| unreachable | machine **enters** `dead` (2 min without heartbeat, per §7 aging) | 2 short buzzes, once |
| recovered | window drops below warn after reset, machine back | none, banner only |

Alerts are evaluated from the merged model, debounced per (machine, kind) so both users'
windows crossing at once produce two alerts, and a flapping heartbeat produces one.
Delivered via `NotificationManager` channels (one per kind) and, in dock mode, a full-screen
Compose overlay for 8 s. Quiet hours: haptics off, overlay still shown at dimmed brightness.

## 11. Screens (`ui/`)

### 11.1 Ledger (portrait home)
Status bar (wifi chip, clock, one dot per machine). Per user: name, email, 5 h and 7 d bars
with percent and reset time. Teammate block at 55 % opacity when stale. Sessions list
grouped by project with model tag, worktree tag, tokens/min, 30-min sparkline, pause button.
Bottom bar: Pause all (amber), Projects, Wifi.

### 11.2 Wide dock (landscape)
Left rail 200 dp: each user's 5 h (64 sp) and 7 d (30 sp) numbers, reset captions, team
today/rate footer. Right pane: same sessions list, five rows visible before scroll, bottom
bar Pause all / Projects / Wifi. Alerts appear as a status-bar chip, not a banner.

### 11.3 Project drill-in
Header: name, worktree count, path. **Three tiles:** today tokens, tokens/min, **share of
today** (project tokens today ÷ that machine's tokens today, shown as "—" when the
denominator is 0). The 5 h window is rolling and account-wide, so no per-project share of it
is computable from the daemon's data; the tile does not pretend otherwise. Five-hour burn
chart (one y scale, gridlines, endpoint dot). In / out / cache % / messages row. Sessions
with short id, since, last tool call (or last activity when the daemon lacks `lastTool`),
escalation countdown, pause button. Bottom: Soft pause
all N, Hold · freeze.

### 11.4 Projects list
Same rows as Ledger's project headers, with idle projects (no live session) listed after,
dimmed, with today's spend only.

### 11.5 Machine detail, Wifi, Pairing, Settings
Settings: warn/critical thresholds, escalation timeout, quiet hours, night dim level, kiosk
exit PIN, update channel (stable only in v1), "check for update now".

### 11.6 Visual system
Dark, single-theme (dock LCD). Ground `#0E1013`, surface `#161A20`, line `#262D37`, text
`#E8EBEF`, muted `#8B95A3`. Semantic: ok `#3DBE8B`, warn `#F0B429`, critical `#E5484D`,
frozen `#5AB4C4`; accent `#8C9BFF` for sparklines and model tags only. Type: Barlow Condensed
for numerals, IBM Plex Sans for text, IBM Plex Mono for data. Tabular numerals everywhere.

## 12. Self-update (`update/`)

- Every 10 min ±10 % (and on "check now"): `GET https://api.github.com/repos/${RELEASE_REPO}/releases/latest` where `RELEASE_REPO`
  is a `BuildConfig` value, default `drmuzikbpn/android-project` (owner provisional, mirrors
  the daemon's).
  Compare tag to `BuildConfig.VERSION_NAME`. Newer → download `usage-deck-<v>.apk` and
  `SHA256SUMS`, verify sha256, then `PackageInstaller` session with
  `setInstallReason(INSTALL_REASON_DEVICE_SETUP)`; Device Owner makes it silent.
- The APK must be signed with the same key as the installed app or Android rejects it.
- Defer while a pause gesture is in progress, a hard-freeze hold is mid-press, **or any
  escalation is pending**; re-check every 30 s. Otherwise install immediately. After install Android relaunches the launcher; the app restores the
  last screen from saved state.
- Failure → machine-independent banner "update failed: <reason>", retry next tick. Keep the
  last APK for manual `adb install -r` recovery.
- Version scheme mirrors the daemon: `0.MINOR.<commit-count>+<sha>` as `versionName`,
  `versionCode` = commit count.

## 13. CI / release

GitHub Actions on push to `main`: `ktlint`, `./gradlew test`, `connectedAndroidTest` on an
API 29 emulator, `assembleRelease` signed from secrets (`SIGNING_KEYSTORE_B64`,
`SIGNING_KEY_ALIAS`, `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_PASSWORD` — master copy in
1Password vault `usagedeck`, item `usagedeck-ci`), then create tag `v<version>` and a release
with the APK + `SHA256SUMS`. Any red step → no release. Pre-commit via lefthook: `ktlint`
and `./gradlew testDebugUnitTest --offline`.

## 14. Testing

- **daemon/**: MockWebServer SSE fixtures from Ethan's repo (`test/fixtures/limits/*.json`,
  plus sessions/pause fixtures once published): snapshot replaces state; each event type;
  reconnect resnapshots; 401 → unauthorized; fallback polling with `If-None-Match` → 304 path.
- **model/**: worktree grouping by git-common-dir; team merge; aging thresholds; share-of-5h
  math.
- **pause/**: state machine — tap soft, hold hard, resume, escalation fires/cancels,
  optimistic revert on 409/410, idempotent repeats, multi-machine fan-out for `all`.
- **alerts/**: threshold crossings, debounce, quiet hours, both users at once.
- **update/**: version compare, sha mismatch rejected, deferral during gesture.
- **ui/**: Compose tests for Ledger, Wide dock, Project drill-in with fixture data; screenshot
  tests at 1080×1920 and 1920×1080.
- **fakedaemon/**: a Kotlin Ktor stub implementing §15–22 with scripted scenarios (warn
  crossing, freeze, machine drop) so the app runs on an emulator with no Mac.
- Manual checklist `docs/smoke-test.md`: device owner set, lock task holds, wifi picker on a
  hotspot, QR pairing, pause a real session, SIGCONT confirmed, OTA install succeeds.

## 15. Repository layout

```
app/src/main/java/com/evenseal/usagedeck/
  kiosk/      DeviceAdminReceiver, KioskManager, ModeController (dock/battery), ExitPin
  wifi/       WifiRepository, CaptivePortalActivity
  pairing/    QrScanner (CameraX + ML Kit-free ZXing), MachineStore
  daemon/     MachineClient, SseParser, RestFallback, Dto*, Aging
  model/      Machine, Session, Project, Limits, PauseRule, TeamModel
  pause/      PauseController, Escalation, Gestures
  alerts/     AlertEvaluator, Notifier, QuietHours
  update/     ReleaseChecker, ApkInstaller
  ui/         ledger/, widedock/, project/, machine/, wifi/, settings/, theme/
app/src/test/, app/src/androidTest/
fakedaemon/   (JVM module)
docs/device-setup.md  docs/teammate-onboarding.md  docs/smoke-test.md
.github/workflows/ci.yml  lefthook.yml  CLAUDE.md  README.md  LICENSE (MIT)
```

## 16. Out of scope for v1
Cellular; EAP wifi; light theme; charge cap (needs root); cross-machine project pause; more than one tailnet; historical spend beyond what the
daemon returns; cost estimates; per-model pause; iOS or web client; signature verification
of releases beyond sha256; burn history persistence across app restarts.

## 17. Dependencies on the daemon (owned by Ethan's spec)
`/health` §15, bind + bearer + pairing §16, `/v1/sessions` §17, pause rules §18, `/v1/events`
§19, auto-update deferral state §20, normalized `limits[]` and `/v1/tokens` §23.
Requested of the daemon 2026-09-13, pending: `session.lastTool {name, at}` from PreToolUse;
error envelope always carries `message`. Confirmed assumptions: `spend` event is
machine-wide; `rule.reason` echoes back verbatim. Fixtures for sessions/pause/events to be published in
the daemon repo under `test/fixtures/`; this app's client tests consume them by path.
