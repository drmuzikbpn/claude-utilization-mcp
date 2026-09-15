## What

<!-- One or two sentences. Link the issue if there is one. -->

## Why

## How it was tested

- [ ] `./gradlew ktlintCheck :core:test :fakedaemon:test :app:testDebugUnitTest`
- [ ] `ANDROID_SERIAL=… ./gradlew :app:connectedDebugAndroidTest` (or: no UI change)
- [ ] Checked on a real device, if kiosk / wifi / pairing / update are touched (`docs/smoke-test.md`)

## Daemon contract

- [ ] No change to what the deck expects from the daemon, **or** the matching daemon PR is linked above
