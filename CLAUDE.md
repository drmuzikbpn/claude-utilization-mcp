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

A real Nexus 5X is often attached over USB alongside the emulator — **always set
`ANDROID_SERIAL`** for anything instrumented, and never `pm uninstall`/`pm clear` the app on the
phone (it would drop Device Owner).

lefthook runs `ktlintCheck` and `:core:test` on pre-commit. Install with `lefthook install` if the
hook is missing.

## Global Constraints

- Package `com.evenseal.usagedeck`. App name "Usage Deck". `minSdk 29`, `targetSdk 29`, `compileSdk 34`.
- Environment: `export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` before any `./gradlew`. `local.properties` holds `sdk.dir=/opt/homebrew/share/android-commandlinetools` and is gitignored.
- Build only on `limits[]` (daemon §23); never read `legacyWindows`. Headline ids: `"session"` (5 h) and `"weekly_all"` (7 d). `resetsAt` may be null → render "resets: unknown".
- `/v1/tokens` is the spend endpoint (not `/v1/spend`). `groupBy=project` returns `{ key, label, …counts }`, `label` = cwd.
- Pause `reason` is exactly `"usage-deck:<installId>"`. Only rules whose `reason` equals this phone's string ever escalate.
- Session and project pause scopes go to one machine. Only `all` fans out.
- Gesture grammar everywhere: tap = soft, hold 600 ms = hard, tap on paused = resume. Red styling only on hold actions.
- Aging: fresh < 30 s since heartbeat, stale < 120 s, dead ≥ 120 s. Dead disables pause controls.
- Escalation default 90 s; range 30 s–600 s or off; persisted across process death.
- Self-update defers while a gesture is in progress, a hold is mid-press, or any escalation is pending.
- Version: `versionName = 0.MINOR.<commit-count>+<sha>`, `versionCode = commit-count`. Release repo `BuildConfig.RELEASE_REPO`, default `drmuzikbpn/android-project` (owner confirmed by Alan 2026-09-13; the daemon lives at `drmuzikbpn/claude-utilization-mcp`).
- Every error shown to the user comes from the daemon envelope: `hint` → `message` → per-code default.
- Single dark theme, colours and fonts from spec §11.6. Tabular numerals everywhere.
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- No `TODO`/`FIXME` left in committed code. No test may be `@Ignore`d.

## Never push

Do not `git push` without explicit approval in the session. CI publishes releases from `main`;
pushing by accident ships an APK to every deck.

## Gotchas

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
