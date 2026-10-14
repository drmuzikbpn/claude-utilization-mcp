# Third-party notices

Usage Deck itself is MIT-licensed (see [LICENSE](LICENSE)). It bundles, or is built with, the
following third-party work. Licence texts are in [`licenses/`](licenses/).

## Fonts bundled in the app (`app/src/main/res/font/`)

| Font | Files | Copyright | Licence |
| --- | --- | --- | --- |
| Barlow Condensed (Medium, SemiBold, Bold) | `barlow_condensed_*.ttf` | Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow) | SIL Open Font License 1.1 — [`licenses/OFL-1.1-Barlow.txt`](licenses/OFL-1.1-Barlow.txt) |
| IBM Plex Sans (Regular, Medium, SemiBold) | `ibm_plex_sans_*.ttf` | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" | SIL Open Font License 1.1 — [`licenses/OFL-1.1-IBM-Plex.txt`](licenses/OFL-1.1-IBM-Plex.txt) |
| IBM Plex Mono (Regular, Medium) | `ibm_plex_mono_*.ttf` | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" | SIL Open Font License 1.1 — [`licenses/OFL-1.1-IBM-Plex.txt`](licenses/OFL-1.1-IBM-Plex.txt) |

The font files are redistributed unmodified.

## Libraries shipped inside the APK

All of these are under the Apache License 2.0 — [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).

| Library | Coordinates | Copyright holder |
| --- | --- | --- |
| Kotlin standard library | `org.jetbrains.kotlin:kotlin-stdlib` | JetBrains s.r.o. and Kotlin contributors |
| kotlinx.coroutines | `org.jetbrains.kotlinx:kotlinx-coroutines-*` | JetBrains s.r.o. |
| kotlinx.serialization | `org.jetbrains.kotlinx:kotlinx-serialization-json` | JetBrains s.r.o. |
| OkHttp, OkHttp SSE | `com.squareup.okhttp3:okhttp`, `okhttp-sse` | Square, Inc. |
| Okio | `com.squareup.okio:okio` | Square, Inc. |
| Jetpack Compose (UI, Material 3) | `androidx.compose.*` | The Android Open Source Project |
| AndroidX Activity, Lifecycle, Navigation, Core | `androidx.activity`, `androidx.lifecycle`, `androidx.navigation`, `androidx.core` | The Android Open Source Project |
| AndroidX Security Crypto | `androidx.security:security-crypto` | The Android Open Source Project |
| Tink (via Security Crypto) | `com.google.crypto.tink:tink-android` | Google LLC |
| ZXing Android Embedded | `com.journeyapps:zxing-android-embedded` | JourneyApps and ZXing authors |
| ZXing core | `com.google.zxing:core` | ZXing authors |

## Used to build and test, not shipped

| Tool | Licence |
| --- | --- |
| Ktor (the `fakedaemon` module) | Apache-2.0 |
| OkHttp MockWebServer and okhttp-tls | Apache-2.0 |
| Gradle and the Gradle wrapper (`gradlew`, `gradle/wrapper/`) | Apache-2.0 |
| Android Gradle Plugin, Kotlin Gradle plugins | Apache-2.0 |
| Turbine | Apache-2.0 |
| AndroidX Test, Espresso | Apache-2.0 |
| Robolectric | MIT |
| ktlint and ktlint-gradle | MIT |
| JUnit 4 | Eclipse Public License 1.0 |

Exact versions are in [`gradle/libs.versions.toml`](gradle/libs.versions.toml).
