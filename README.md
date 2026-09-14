# Usage Deck

A Nexus 5X running LineageOS, bolted to a shelf, showing what every Claude Code session on the
team is burning right now — and letting you stop one with a thumb.

It is a Device Owner kiosk launcher: it streams from N `claude-usage` daemons over Tailscale,
merges them into one view, and can soft-pause or hard-freeze a session, a project, or everything
at once.

![Ledger, portrait](docs/images/ledger.png)
![Wide dock, landscape](docs/images/wide-dock.png)
![Project drill-in](docs/images/project.png)

*(Screenshots are placeholders until the deck is photographed in place.)*

## What it does

- **Ledger (portrait)** — each person's 5 h and 7 d utilisation with reset times, then every live
  session grouped by project, with tokens/min and a 30-minute sparkline.
- **Wide dock (landscape)** — the same data as numbers big enough to read across a room.
- **Pause** — tap for a soft pause, hold 600 ms to freeze. A soft pause escalates to a freeze
  after 90 s unless you resume it. Red styling appears only while you are actually holding.
- **Alerts** — full-screen in the dock, heads-up notification on battery, silenced (but still
  visible) during quiet hours.
- **Self-update** — polls its own GitHub releases every 10 minutes, verifies sha256, and installs
  silently as Device Owner — but never while a gesture or an escalation is in flight.

## Modules

| Module | What it is | Tests |
| --- | --- | --- |
| `core` | Pure Kotlin/JVM: model, daemon client, SSE, team merge, pause state machine, alerts, update check | 127 |
| `app` | Android: kiosk, wifi, pairing, Compose UI, foreground service, installer | 107 unit + 42 instrumented |
| `fakedaemon` | Ktor server implementing the daemon contract with scripted scenarios | 5 |

## Build and run

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools

./gradlew :core:test :fakedaemon:test :app:testDebugUnitTest   # JVM + Robolectric
./gradlew :app:assembleDebug
./gradlew ktlintFormat                                          # before every commit
```

Instrumented tests need a device. A real Nexus 5X and the emulator are usually both attached, so
**always pin the serial**:

```bash
scripts/emulator.sh                                             # starts/creates the deck29 AVD
ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedDebugAndroidTest
```

## Running without a Mac

`fakedaemon` implements the daemon contract, so the app runs on an emulator with nothing else:

```bash
scripts/fakedaemon.sh warnCrossing      # also: idle, freeze, machineDrop
```

Pair the emulator against `10.0.2.2` on the port the script printed, with token `fake-token`.

## Setting up a phone

See **[docs/device-setup.md](docs/device-setup.md)** — flashing LineageOS 17.1, skipping
provisioning, `dpm set-device-owner`, Tailscale, and the one-tap Doze exemption.

Teammates adding their own Mac want **[docs/teammate-onboarding.md](docs/teammate-onboarding.md)**.

Before shipping a release that touches kiosk, wifi, pairing or update, run
**[docs/smoke-test.md](docs/smoke-test.md)** on the real phone.

## Releases

The app lives on the `usage-deck` branch of the daemon's repo, `drmuzikbpn/claude-utilization-mcp`.
CI runs ktlint, all JVM tests and the instrumented suite on an API 29 emulator. On `usage-deck`,
once the signing secrets exist, it also assembles a signed release and publishes it under the
namespace the two updaters agreed on (daemon spec §23.17): tag `deck-<version>`, assets
`usage-deck.apk` and `usage-deck.apk.sha256`, always flagged pre-release so the daemon's
`/releases/latest` never returns an APK. The deck's updater lists releases and considers `deck-`
tags only, so a daemon tarball never looks installable to it.

Versions are `0.MINOR.<commit-count>+<short-sha>`; `versionCode` is the commit count.

Signing secrets (`SIGNING_KEYSTORE_B64`, `SIGNING_KEY_ALIAS`, `SIGNING_STORE_PASSWORD`,
`SIGNING_KEY_PASSWORD`) are populated in GitHub from **1Password vault `usagedeck`, item
`usagedeck-ci`**. Generating the keystore is a one-off human step, written up in
[docs/device-setup.md](docs/device-setup.md) under *Release signing*.

## Licence

MIT — see [LICENSE](LICENSE).
