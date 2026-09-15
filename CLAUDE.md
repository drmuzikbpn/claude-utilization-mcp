# Usage Deck — working notes

Nexus 5X Device Owner kiosk that streams Claude Code utilisation from N `claude-usage` daemons
over Tailscale and pauses/resumes sessions.

## Environment

Every Gradle call needs both:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
```

`local.properties` holds `sdk.dir=/opt/homebrew/share/android-commandlinetools` and is gitignored.

## Modules

| Path | What lives there |
| --- | --- |
| `core/` | Pure Kotlin/JVM. `model/`, `daemon/` (REST + SSE + `MachineClient`), `pause/`, `alerts/`, `update/`, `Clock.kt`. No Android APIs. |
| `app/` | Android. `kiosk/`, `wifi/`, `pairing/`, `service/` (`DeckGraph`, `DeckService`), `settings/`, `update/`, `ui/` (`theme/`, `components/`, one package per screen). |
| `fakedaemon/` | Ktor server implementing the daemon contract with scripted scenarios. |

## Commands

```bash
./gradlew :core:test :fakedaemon:test :app:testDebugUnitTest   # JVM + Robolectric
./gradlew :app:assembleDebug
./gradlew ktlintFormat                                          # run before every commit

scripts/emulator.sh                                             # start/create the deck29 AVD
ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedDebugAndroidTest
scripts/fakedaemon.sh warnCrossing                              # idle | warnCrossing | freeze | machineDrop
```

To see real numbers on the emulator, push this Mac's own pairing file (LAN address; the daemon
rejects the emulator's `10.0.2.2` loopback with "Host header is not an address this daemon is bound to"):
`adb -s emulator-5554 push ~/.config/claude-usage/pairing.json /sdcard/Android/data/com.evenseal.usagedeck/files/pairing-import.json`.
Never print that file: it holds the bearer token. `connectedDebugAndroidTest` wipes the pairing, so
push it again afterwards. Landscape is `adb -s emulator-5554 emu rotate`. Show UI changes there and
wait for Alan's OK before pushing a release.

A real Nexus 5X is often attached over USB alongside the emulator — **always set
`ANDROID_SERIAL`** for anything instrumented, and never `pm uninstall`/`pm clear` the app on the
phone (it would drop Device Owner). The phone runs release-signed builds since 2026-09-14, so
`run-as` no longer works there: sideload a pairing with
`adb push pairing.json /sdcard/Android/data/com.evenseal.usagedeck/files/pairing-import.json`.

lefthook runs `ktlintCheck` and `:core:test` on pre-commit. Install with `lefthook install` if the
hook is missing.

## Global Constraints

- Package `com.evenseal.usagedeck`. App name "Usage Deck". `minSdk 29`, `targetSdk 29`, `compileSdk 34`.
- Environment: `export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` before any `./gradlew`. `local.properties` holds `sdk.dir=/opt/homebrew/share/android-commandlinetools` and is gitignored.
- Build only on `limits[]` (daemon §23); never read `legacyWindows`. Headline ids: `"session"` (5 h) and `"weekly_all"` (7 d). `resetsAt` may be null → render "resets: unknown".
- `/v1/tokens` is the spend endpoint (not `/v1/spend`). `groupBy=project` returns `{ key, label, …counts }`, `label` = cwd.
- Pause `reason` is exactly `"usage-deck:<installId>"`. Only rules whose `reason` equals this phone's string ever escalate.
- Session and project pause scopes go to one machine. Only `all` fans out.
- Users are keyed by account **and** organisation (`accountUuid/organizationUuid`): team-plan limits are
  per org, and Alan's one account sits in two orgs. Display names are the deck's own renames
  (`Settings.userNames`, Settings › Users) falling back to the daemon's `displayName`, then the e-mail's local part.
- Gesture grammar everywhere: tap = soft, hold 600 ms = hard, tap on paused = resume. Red styling only on hold actions.
- Aging: fresh < 30 s since heartbeat, stale < 120 s, dead ≥ 120 s. Dead disables pause controls.
- Escalation default 90 s; range 30 s–600 s or off; persisted across process death.
- Self-update defers while a gesture is in progress, a hold is mid-press, or any escalation is pending.
- Version: `versionName = 0.MINOR.<commit-count>+<sha>`, `versionCode = commit-count`. Release repo `BuildConfig.RELEASE_REPO`, default `drmuzikbpn/claude-utilization-mcp` (shared with the daemon): APK releases are tags `deck-<version>`, pre-release, assets `usage-deck.apk` + `usage-deck.apk.sha256`; the checker considers `deck-` tags only. CI signs with `apksigner` + `app/signing/usage-deck.lineage` (v3, rotated from this Mac's debug key) so the debug-provisioned phone updates in place; Gradle never signs release.
- Every error shown to the user comes from the daemon envelope: `hint` → `message` → per-code default.
- Single dark theme, colours and fonts from spec §11.6. Tabular numerals everywhere.
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- No `TODO`/`FIXME` left in committed code. No test may be `@Ignore`d.

## Remote and pushing

This project lives on the orphan branch `usage-deck` of `drmuzikbpn/claude-utilization-mcp` (the
daemon's repo; local `main` tracks `origin/usage-deck`, pushed 2026-09-14 with Alan's approval).
Do not `git push` without explicit approval in the session. CI runs on pushes to `usage-deck` only
(never a wildcard: the daemon's release job runs on `main`) and publishes a `deck-<version>`
pre-release once the signing secrets exist; until then it only tests.

## Gotchas

- `BurnHistory` is written on the SSE thread and read by Compose on main; every method locks and
  readers work on a snapshot. Dropping the lock crashes the kiosk with ConcurrentModificationException
  every few minutes on the real phone (it did, four times in half an hour).
- Daemons before 0.1.66 resume exactly the scope they are given (the Studio is on 0.1.0); newer ones
  cascade a project resume and keep one rule per scope. The phone fans a project resume out to the
  session rules under it so both behave; resuming an already-lifted scope is a no-op.
- Hard freeze (daemon §23.16, from the release after 0.1.65) stops only tool subprocesses and holds
  the next tool at the gate; `pause.frozenPids` never holds the session pid and an empty list under a
  hard rule is normal. `pause.freezes` ≥ 2 means re-frozen under a standing rule (rendered "frozen again ×N").
  On 0.1.65 and earlier the freeze SIGSTOPs the TUI itself; zsh shows "suspended (signal)" and needs `fg`.
- `STAY_ON_WHILE_PLUGGED_IN` only stops the screen turning off; Android still dims it after the
  inactivity timeout. `ScreenHold` keeps `FLAG_KEEP_SCREEN_ON` whenever the deck is on power (adaptive
  brightness still works), and on battery only when "Keep screen on" is set.
- A self-update kills the process and Android never restarts a HOME activity on its own; `LockTaskReceiver`
  relaunches the deck on `MY_PACKAGE_REPLACED`. The first unattended update (0.1.55) sat on the stock launcher without it.
- List rows animate with `animateItem` + `liftOnReorder(rowRank(project, row))`. Rank by project slot,
  never by a running row index: a running index makes every row below a fold or a new session "move"
  and blink.
- Run the instrumented suite with the emulator's *sensor* in portrait: `adb -s emulator-5554 emu sensor get acceleration`
  must read `0:9.81:0` (`emu rotate` cycles it). The launcher can look portrait while the test activity,
  which follows the sensor, opens landscape, and `WifiScreenTest` then fails because its fourth
  network row is below the fold.
- Compose: `Modifier.clickable` merges descendant semantics, so pause buttons inside a clickable
  row are only addressable with `useUnmergedTree = true`.
- Android 10 returns an **empty** wifi scan list without location permission rather than throwing.
  `KioskManager.applyPolicies()` grants `ACCESS_FINE_LOCATION` and `CAMERA` as Device Owner.
- Doze exemption is a one-tap dialog on first launch; Device Owner cannot write it on API 29.
- `fakedaemon` serves REST fine inside an Android process, but its SSE `snapshot` frame truncates
  on-device — `EndToEndTest` scripts its own stream instead.

## Docs

`docs/device-setup.md` (flashing and provisioning), `docs/teammate-onboarding.md` (adding a Mac),
`docs/smoke-test.md` (manual checklist before a release).
