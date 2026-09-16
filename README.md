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

- **Ledger (portrait)** — one folded line per person (`5h 42%  7d 18%`; tap to unfold the bars,
  reset times and model-scoped windows), then every live session grouped by project. Project rows
  start folded with a project sparkline and a project pause; tap to see the sessions. Sessions show
  their `/rename` title when they have one.
- **Wide dock (landscape)** — the same data as numbers big enough to read across a room. With
  more than one account paired, the rings page sideways: swipe to the next account, its name
  above the circles. Several machines on one account are one quota and stay one page.
- **People** — quotas are per account *and* organisation, so one account on a team seat and on a
  personal plan is two rows. Long-press a row (or use *Settings › Users*) to name it.
- **Pause** — tap for a soft pause, hold 600 ms to freeze. A soft pause holds the session at its
  next tool call and escalates to a freeze after 90 s unless you resume it. A freeze stops the
  tool that is running and holds the next one; the Claude Code process itself keeps running, so
  the terminal is never suspended. A freeze longer than the session's tool timeout (2 min by
  default) ends the tool that was running. Red styling appears only while you are actually holding.
- **Settings (gear)** — wifi, keep-screen-on, auto-dim at night, 12/24 h clock, alert chime, user
  names, thresholds, escalation, quiet hours, exit PIN and updates.
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

## Pairing a Mac

On any Mac running the `claude-usage` daemon (from `main` of this repo, reachable over Tailscale):

```bash
claude-usage configure pairing
```

That prints a QR code. On the deck, open **Projects → Pairing → Scan QR** and hold the phone up
to the Mac's screen. The QR is a live bearer token: scan it off the Mac's own display, never a
photo or a shared screen, and run `claude-usage configure rotate-token` if it is ever exposed.
Repeat for each Mac; the deck merges them into one view. The full walkthrough, including
Tailscale and what "Token rejected" means, is in
[docs/teammate-onboarding.md](docs/teammate-onboarding.md).

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
`usagedeck-ci`**. CI signs with `apksigner` and `app/signing/usage-deck.lineage`, a rotation from
the debug key the phone was provisioned with, so releases install over it in place; the story is
in [docs/device-setup.md](docs/device-setup.md) under *Release signing*.

## Licence

MIT — see [LICENSE](LICENSE).
