# Usage Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Usage Deck Android kiosk app: a Nexus 5X launcher that streams Claude Code utilization from N `claude-usage` daemons over Tailscale and pauses/resumes sessions.

**Architecture:** Three Gradle modules. `core` is pure Kotlin/JVM (model, daemon client, team merge, pause state machine, alert evaluator, update checker) and is fully unit-tested with MockWebServer and fake clocks. `app` is Android (Device Owner kiosk, wifi, QR pairing, Compose UI, foreground service, APK installer) and depends on `core`. `fakedaemon` is a JVM Ktor server implementing the daemon contract with scripted scenarios so the app runs on an emulator without a Mac.

**Tech Stack:** Kotlin 2.0.21, AGP 8.7.3, Gradle 8.10, JDK 17, compileSdk 34, minSdk 29, targetSdk 29, Jetpack Compose (BOM 2024.10.01), Navigation-Compose, kotlinx-coroutines 1.9, kotlinx-serialization-json 1.7, OkHttp 4.12 + okhttp-sse, androidx.security-crypto 1.1.0-alpha06, zxing-android-embedded 4.3.0, Ktor 2.3.12 (fakedaemon only), JUnit4, MockWebServer 4.12, Turbine 1.1, kotlinx-coroutines-test, Robolectric 4.13 (app unit tests), ktlint-gradle 12.1.1, lefthook.

**Spec:** `docs/superpowers/specs/2026-09-13-usage-dashboard-phone-design.md` (this repo) and `~/code/claude-utilization-mcp/docs/superpowers/specs/2026-09-13-claude-usage-design.md` Part II §15–22 and §23 (the daemon contract; read §17, §18, §19, §23 before touching `core/daemon`).

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

## Tracks

- **Task 1** (scaffold) is done first, alone.
- **Track A — `core` + `fakedaemon`:** Tasks 2–10. Pure JVM. Owner: implementer A.
- **Track B — `app`:** Tasks 11–19. Android. Owner: implementer B. Tasks 11–14 depend only on Task 1; Tasks 15–19 consume Track A interfaces exactly as written in each task's **Interfaces** block (compile against them; if A has not landed yet, B uses the `core` stubs Task 1 creates).
- **Task 20** (integration, CI, docs) after both tracks.

## File structure

```
settings.gradle.kts, build.gradle.kts, gradle/libs.versions.toml, gradle.properties, lefthook.yml
core/build.gradle.kts
core/src/main/kotlin/com/evenseal/usagedeck/core/
  model/Types.kt            data classes: MachineConfig, MachineState, Session, Limit, PauseRule, Tokens, …
  model/TeamState.kt        merge N MachineState → users, projects, team totals
  model/BurnHistory.kt      ring buffer → tokens/min + series
  model/Aging.kt            Health from lastHeartbeatAt
  daemon/Dto.kt             kotlinx-serialization DTOs mirroring daemon JSON
  daemon/DaemonApi.kt       interface + OkHttp implementation (REST)
  daemon/SseEvents.kt       DaemonEvent sealed class + parser from (event, data)
  daemon/EventSource.kt     OkHttp SSE wrapper → Flow<DaemonEvent> with reconnect/backoff
  daemon/MachineClient.kt   owns one machine's MachineState (SSE + fallback polling + aging)
  daemon/Errors.kt          DaemonException(code, message, hint) + userMessage()
  pause/PauseTarget.kt      sealed targets, scope string mapping
  pause/EscalationStore.kt  interface + InMemory impl
  pause/PauseController.kt  soft/hard/resume/escalate, optimistic + fan-out
  alerts/AlertEvaluator.kt  pure diff → List<Alert>
  update/Version.kt         parse + compare 0.MINOR.<n>+<sha>
  update/ReleaseChecker.kt  GitHub latest release → ReleaseInfo, sha256 verify
  Clock.kt                  fun interface Clock { fun now(): Instant }
core/src/test/kotlin/...    one test file per source file above
fakedaemon/build.gradle.kts
fakedaemon/src/main/kotlin/com/evenseal/usagedeck/fakedaemon/
  Main.kt                   `--port --scenario` CLI
  FakeDaemon.kt             Ktor routes: /health /v1/summary /v1/sessions /v1/tokens /v1/pause /v1/resume /v1/pause/rules /v1/events
  Scenarios.kt              idle, warnCrossing, freeze, machineDrop
app/build.gradle.kts, app/src/main/AndroidManifest.xml
app/src/main/kotlin/com/evenseal/usagedeck/
  UsageDeckApp.kt           Application: DI graph (manual), installId
  MainActivity.kt           single Activity, NavHost, orientation → Ledger/WideDock
  kiosk/DeviceAdminReceiver.kt  kiosk/KioskManager.kt  kiosk/ModeController.kt  kiosk/ExitPin.kt
  wifi/WifiRepository.kt    wifi/CaptivePortalActivity.kt
  pairing/MachineStore.kt   pairing/PairingPayload.kt  pairing/QrScanActivity.kt
  service/DeckService.kt    foreground service: clients, alerts, escalations, update loop
  alerts/Notifier.kt        channels + haptics + dock overlay state
  update/ApkInstaller.kt    PackageInstaller session
  pause/PrefsEscalationStore.kt
  ui/theme/Theme.kt Color.kt Type.kt
  ui/components/StatusBar.kt LimitBar.kt Sparkline.kt PauseButton.kt SessionRow.kt BottomBar.kt
  ui/ledger/LedgerScreen.kt  ui/widedock/WideDockScreen.kt  ui/project/ProjectScreen.kt
  ui/projects/ProjectsScreen.kt  ui/machine/MachineScreen.kt  ui/wifi/WifiScreen.kt
  ui/settings/SettingsScreen.kt  ui/pairing/PairingScreen.kt  ui/alerts/AlertOverlay.kt
app/src/test/kotlin/...     Robolectric unit tests
app/src/androidTest/kotlin/...  Compose UI tests
docs/device-setup.md docs/teammate-onboarding.md docs/smoke-test.md
.github/workflows/ci.yml  CLAUDE.md  README.md  LICENSE
```

---

### Task 1: Gradle scaffold, three modules, core stubs, lefthook

**Files:**
- Create: `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/libs.versions.toml`, `local.properties` (gitignored), `lefthook.yml`, `.editorconfig`
- Create: `core/build.gradle.kts`, `core/src/main/kotlin/com/evenseal/usagedeck/core/Clock.kt`, `core/src/main/kotlin/com/evenseal/usagedeck/core/model/Types.kt`
- Create: `fakedaemon/build.gradle.kts`, `fakedaemon/src/main/kotlin/com/evenseal/usagedeck/fakedaemon/Main.kt` (prints "fakedaemon" and exits)
- Create: `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `app/src/main/kotlin/com/evenseal/usagedeck/MainActivity.kt` (empty Compose `Text("Usage Deck")`)
- Create: `core/src/test/kotlin/com/evenseal/usagedeck/core/model/TypesTest.kt`

**Interfaces (Produces — every later task uses these exact names):**

```kotlin
// core/Clock.kt
package com.evenseal.usagedeck.core
import java.time.Instant
fun interface Clock { fun now(): Instant }
object SystemClock : Clock { override fun now(): Instant = Instant.now() }
class FakeClock(var current: Instant) : Clock {
    override fun now() = current
    fun advance(seconds: Long) { current = current.plusSeconds(seconds) }
}
```

```kotlin
// core/model/Types.kt
package com.evenseal.usagedeck.core.model
import java.time.Instant

data class MachineConfig(val id: String, val name: String, val addr: String, val port: Int, val token: String) {
    val baseUrl: String get() = "http://$addr:$port"
}
enum class Health { FRESH, STALE, DEAD }
data class User(val emailAddress: String?, val accountUuid: String?, val displayName: String?)
enum class LimitStatus { OK, WARN, CRITICAL }
data class Limit(
    val id: String, val kind: String, val group: String, val percent: Int, val severity: String,
    val resetsAt: Instant?, val scopeModel: String?, val isActive: Boolean, val status: LimitStatus,
)
data class Tokens(val input: Long = 0, val output: Long = 0, val cacheCreate: Long = 0, val cacheRead: Long = 0, val messages: Long = 0) {
    val total: Long get() = input + output + cacheCreate + cacheRead
    operator fun plus(o: Tokens) = Tokens(input + o.input, output + o.output, cacheCreate + o.cacheCreate, cacheRead + o.cacheRead, messages + o.messages)
    companion object { val ZERO = Tokens() }
}
enum class PauseMode { SOFT, HARD }
data class PauseState(val mode: PauseMode, val ruleId: String, val scope: String, val since: Instant, val frozenPids: List<Int>)
data class LastTool(val name: String, val at: Instant)
enum class Discovered { HOOK, TRANSCRIPT }
data class Session(
    val sessionId: String, val pid: Int?, val alive: Boolean, val discovered: Discovered,
    val cwd: String, val transcriptPath: String?, val projectKey: String, val projectName: String,
    val worktree: String?, val model: String?, val startedAt: Instant, val lastActivityAt: Instant,
    val tokens: Tokens, val pause: PauseState?, val lastTool: LastTool?,
) { val canHardPause: Boolean get() = discovered == Discovered.HOOK && pid != null }
data class PauseRule(val id: String, val scope: String, val mode: PauseMode, val reason: String?, val createdAt: Instant, val createdBy: String)
data class UpdateState(val channel: String, val current: String, val available: String?, val state: String, val deferredReason: String?)
data class ProjectTokens(val key: String, val label: String, val tokens: Tokens)
data class MachineState(
    val config: MachineConfig,
    val health: Health = Health.DEAD,
    val lastHeartbeatAt: Instant? = null,
    val name: String? = null,
    val version: String? = null,
    val user: User? = null,
    val limits: List<Limit> = emptyList(),
    val limitsFetchedAt: Instant? = null,
    val today: Tokens = Tokens.ZERO,
    val sessions: List<Session> = emptyList(),
    val rules: List<PauseRule> = emptyList(),
    val update: UpdateState? = null,
    val projectTokens: List<ProjectTokens> = emptyList(),
    val rev: Long = 0,
    val lastError: String? = null,
    val transport: Transport = Transport.DISCONNECTED,
) { enum class Transport { SSE, POLLING, DISCONNECTED } }
```

- [ ] **Step 1: Write `settings.gradle.kts`, root `build.gradle.kts`, version catalog**

`settings.gradle.kts`:
```kotlin
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "usage-deck"
include(":core", ":fakedaemon", ":app")
```
`gradle/libs.versions.toml`:
```toml
[versions]
agp = "8.7.3"
kotlin = "2.0.21"
coroutines = "1.9.0"
serialization = "1.7.3"
okhttp = "4.12.0"
composeBom = "2024.10.01"
navigation = "2.8.3"
activityCompose = "1.9.3"
lifecycle = "2.8.7"
securityCrypto = "1.1.0-alpha06"
zxingEmbedded = "4.3.0"
ktor = "2.3.12"
junit = "4.13.2"
turbine = "1.1.0"
robolectric = "4.13"
ktlint = "12.1.1"
androidxTestExt = "1.2.1"
espresso = "3.6.1"

[libraries]
coroutines-core = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-core", version.ref = "coroutines" }
coroutines-android = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-android", version.ref = "coroutines" }
coroutines-test = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-test", version.ref = "coroutines" }
serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "serialization" }
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
okhttp-sse = { module = "com.squareup.okhttp3:okhttp-sse", version.ref = "okhttp" }
okhttp-mockwebserver = { module = "com.squareup.okhttp3:mockwebserver", version.ref = "okhttp" }
compose-bom = { module = "androidx.compose:compose-bom", version.ref = "composeBom" }
compose-ui = { module = "androidx.compose.ui:ui" }
compose-material3 = { module = "androidx.compose.material3:material3" }
compose-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
compose-ui-test-junit4 = { module = "androidx.compose.ui:ui-test-junit4" }
compose-ui-test-manifest = { module = "androidx.compose.ui:ui-test-manifest" }
navigation-compose = { module = "androidx.navigation:navigation-compose", version.ref = "navigation" }
activity-compose = { module = "androidx.activity:activity-compose", version.ref = "activityCompose" }
lifecycle-runtime-compose = { module = "androidx.lifecycle:lifecycle-runtime-compose", version.ref = "lifecycle" }
lifecycle-service = { module = "androidx.lifecycle:lifecycle-service", version.ref = "lifecycle" }
security-crypto = { module = "androidx.security:security-crypto", version.ref = "securityCrypto" }
zxing-embedded = { module = "com.journeyapps:zxing-android-embedded", version.ref = "zxingEmbedded" }
ktor-server-core = { module = "io.ktor:ktor-server-core", version.ref = "ktor" }
ktor-server-cio = { module = "io.ktor:ktor-server-cio", version.ref = "ktor" }
ktor-server-content-negotiation = { module = "io.ktor:ktor-server-content-negotiation", version.ref = "ktor" }
ktor-serialization-json = { module = "io.ktor:ktor-serialization-kotlinx-json", version.ref = "ktor" }
junit = { module = "junit:junit", version.ref = "junit" }
turbine = { module = "app.cash.turbine:turbine", version.ref = "turbine" }
robolectric = { module = "org.robolectric:robolectric", version.ref = "robolectric" }
androidx-test-ext = { module = "androidx.test.ext:junit", version.ref = "androidxTestExt" }
espresso-core = { module = "androidx.test.espresso:espresso-core", version.ref = "espresso" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
compose-compiler = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
ktlint = { id = "org.jlleitschuh.gradle.ktlint", version.ref = "ktlint" }
```
Root `build.gradle.kts`:
```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
    alias(libs.plugins.ktlint) apply false
}
subprojects { apply(plugin = "org.jlleitschuh.gradle.ktlint") }
```
`gradle.properties`:
```
org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
org.gradle.caching=true
```
`local.properties`: `sdk.dir=/opt/homebrew/share/android-commandlinetools`.

- [ ] **Step 2: Gradle wrapper**

Run: `cd /Users/adminmcgee/code/android-project && export JAVA_HOME=/opt/homebrew/opt/openjdk@17 && brew install gradle && gradle wrapper --gradle-version 8.10.2 && ./gradlew --version`
Expected: prints Gradle 8.10.2, Kotlin, JVM 17.

- [ ] **Step 3: `core/build.gradle.kts`**

```kotlin
plugins { alias(libs.plugins.kotlin.jvm); alias(libs.plugins.kotlin.serialization) }
kotlin { jvmToolchain(17) }
dependencies {
    implementation(libs.coroutines.core)
    implementation(libs.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.okhttp.mockwebserver)
}
```

- [ ] **Step 4: `fakedaemon/build.gradle.kts`**

```kotlin
plugins { alias(libs.plugins.kotlin.jvm); alias(libs.plugins.kotlin.serialization); application }
kotlin { jvmToolchain(17) }
application { mainClass.set("com.evenseal.usagedeck.fakedaemon.MainKt") }
dependencies {
    implementation(project(":core"))
    implementation(libs.ktor.server.core); implementation(libs.ktor.server.cio)
    implementation(libs.ktor.server.content.negotiation); implementation(libs.ktor.serialization.json)
    implementation(libs.coroutines.core)
    testImplementation(libs.junit); testImplementation(libs.coroutines.test); testImplementation(libs.okhttp)
}
```
`Main.kt`: `fun main(args: Array<String>) { println("fakedaemon ${args.joinToString(" ")}") }`

- [ ] **Step 5: `app/build.gradle.kts` with commit-stamped version**

```kotlin
import java.io.ByteArrayOutputStream
plugins { alias(libs.plugins.android.application); alias(libs.plugins.kotlin.android); alias(libs.plugins.compose.compiler); alias(libs.plugins.kotlin.serialization) }

fun git(vararg cmd: String): String = ByteArrayOutputStream().use { out ->
    exec { commandLine("git", *cmd); standardOutput = out; isIgnoreExitValue = true }; out.toString().trim()
}
val commitCount = git("rev-list", "--count", "HEAD").toIntOrNull() ?: 1
val shortSha = git("rev-parse", "--short", "HEAD").ifBlank { "dev" }

android {
    namespace = "com.evenseal.usagedeck"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.evenseal.usagedeck"
        minSdk = 29; targetSdk = 29
        versionCode = commitCount
        versionName = "0.1.$commitCount+$shortSha"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "RELEASE_REPO", "\"${System.getenv("RELEASE_REPO") ?: "drmuzikbpn/android-project"}\"")
    }
    signingConfigs {
        create("release") {
            val ks = System.getenv("SIGNING_KEYSTORE_PATH")
            if (ks != null) {
                storeFile = file(ks); storePassword = System.getenv("SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("SIGNING_KEY_ALIAS"); keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("release") }
        debug { applicationIdSuffix = "" }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
dependencies {
    implementation(project(":core"))
    val bom = platform(libs.compose.bom); implementation(bom); androidTestImplementation(bom)
    implementation(libs.compose.ui); implementation(libs.compose.material3); implementation(libs.compose.tooling.preview)
    implementation(libs.navigation.compose); implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose); implementation(libs.lifecycle.service)
    implementation(libs.coroutines.android); implementation(libs.serialization.json)
    implementation(libs.okhttp); implementation(libs.security.crypto); implementation(libs.zxing.embedded)
    testImplementation(libs.junit); testImplementation(libs.robolectric); testImplementation(libs.coroutines.test); testImplementation(libs.turbine)
    androidTestImplementation(libs.androidx.test.ext); androidTestImplementation(libs.espresso.core); androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
```
`AndroidManifest.xml` (minimal; Task 11 fills in kiosk pieces):
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:name=".UsageDeckApp" android:label="Usage Deck" android:theme="@android:style/Theme.Material.NoActionBar" android:usesCleartextTraffic="true">
    <activity android:name=".MainActivity" android:exported="true" android:launchMode="singleTask" android:configChanges="orientation|screenSize|screenLayout|keyboardHidden">
      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
    </activity>
  </application>
</manifest>
```
`UsageDeckApp.kt`: `class UsageDeckApp : Application()`. `MainActivity.kt`: `setContent { Text("Usage Deck") }`.

- [ ] **Step 6: `Clock.kt` and `Types.kt` exactly as in Interfaces above**

- [ ] **Step 7: Failing test for `Tokens`**

`core/src/test/kotlin/com/evenseal/usagedeck/core/model/TypesTest.kt`:
```kotlin
package com.evenseal.usagedeck.core.model
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class TypesTest {
    @Test fun `tokens total sums the four counters not messages`() {
        val t = Tokens(input = 1, output = 2, cacheCreate = 3, cacheRead = 4, messages = 99)
        assertEquals(10L, t.total)
    }
    @Test fun `tokens plus adds fieldwise`() {
        assertEquals(Tokens(2, 4, 6, 8, 10), Tokens(1, 2, 3, 4, 5) + Tokens(1, 2, 3, 4, 5))
    }
    @Test fun `session canHardPause requires hook discovery and pid`() {
        val base = Session("s", 1, true, Discovered.HOOK, "/x", null, "k", "x", null, null, Instant.EPOCH, Instant.EPOCH, Tokens.ZERO, null, null)
        assertTrue(base.canHardPause)
        assertFalse(base.copy(pid = null).canHardPause)
        assertFalse(base.copy(discovered = Discovered.TRANSCRIPT).canHardPause)
    }
    @Test fun `machine config builds http base url`() {
        assertEquals("http://100.68.1.2:47291", MachineConfig("m", "n", "100.68.1.2", 47291, "t").baseUrl)
    }
}
```

- [ ] **Step 8: Build everything and run the test**

Run: `./gradlew :core:test :fakedaemon:build :app:assembleDebug --no-daemon`
Expected: BUILD SUCCESSFUL; 4 tests pass; `app/build/outputs/apk/debug/app-debug.apk` exists.

- [ ] **Step 9: lefthook + editorconfig**

`lefthook.yml`:
```yaml
pre-commit:
  parallel: false
  commands:
    ktlint:
      run: JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew ktlintCheck --offline -q
    unit:
      run: JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :core:test --offline -q
```
`.editorconfig`: `[*.{kt,kts}]` with `ktlint_code_style = android_studio`, `max_line_length = 120`.
Run: `lefthook install && ./gradlew ktlintFormat`

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "build: scaffold core, fakedaemon and app modules with lefthook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Track A — core + fakedaemon

### Task 2: DTOs and JSON parsing against daemon fixtures

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/daemon/Dto.kt`
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/daemon/Mapping.kt`
- Create: `core/src/test/resources/fixtures/health.json`, `summary.json`, `sessions.json`, `pause-rule.json`, `tokens-project.json`, `error-401.json`
- Test: `core/src/test/kotlin/com/evenseal/usagedeck/core/daemon/DtoTest.kt`

**Interfaces:**
- Produces: `val DaemonJson: Json` (lenient, ignoreUnknownKeys, explicitNulls=false); DTOs `HealthDto`, `SummaryDto`, `LimitDto`, `SessionsDto`, `SessionDto`, `PauseStateDto`, `PauseRuleDto`, `PauseResponseDto`, `ResumeResponseDto`, `TokensDto`, `TokensGroupDto`, `ErrorEnvelopeDto`, `UpdateDto`, `UserDto`; mappers `SessionDto.toModel(): Session`, `LimitDto.toModel(status: LimitStatus): Limit`, `PauseRuleDto.toModel(): PauseRule`, `TokensCountsDto.toModel(): Tokens`, `UpdateDto.toModel(): UpdateState`, `UserDto.toModel(): User`.

Fixtures come from the daemon repo when published (`~/code/claude-utilization-mcp/test/fixtures/`). Until then, author them from daemon spec §15, §17.3, §18.4, §23 literally. `sessions.json`:
```json
{ "rev": 42, "sessions": [
  { "sessionId": "7f3a9c2e-1111-4b2b-9c1d-000000000001", "pid": 48211, "alive": true, "discovered": "hook",
    "cwd": "/Users/alan/code/calendarpa", "transcriptPath": "/Users/alan/.claude/projects/-Users-alan-code-calendarpa/7f3a.jsonl",
    "project": { "gitCommonDir": "/Users/alan/code/calendarpa/.git", "name": "calendarpa" }, "worktree": null,
    "model": "claude-opus-5", "startedAt": "2026-09-13T11:20:00Z", "lastActivityAt": "2026-09-13T14:01:58Z",
    "tokens": { "input": 1200000, "output": 48000, "cacheCreate": 90000, "cacheRead": 3100000, "messages": 210 },
    "pause": null, "lastTool": { "name": "Read", "at": "2026-09-13T14:01:58Z" } },
  { "sessionId": "c21e0000-2222-4b2b-9c1d-000000000002", "pid": 48990, "alive": true, "discovered": "hook",
    "cwd": "/Users/alan/code/calendarpa-wt/billing", "transcriptPath": null,
    "project": { "gitCommonDir": "/Users/alan/code/calendarpa/.git", "name": "calendarpa" }, "worktree": "billing",
    "model": "claude-sonnet-5", "startedAt": "2026-09-13T13:05:00Z", "lastActivityAt": "2026-09-13T14:01:40Z",
    "tokens": { "input": 410000, "output": 20000, "cacheCreate": 0, "cacheRead": 900000, "messages": 80 },
    "pause": { "mode": "soft", "ruleId": "r-1", "scope": "session:c21e0000-2222-4b2b-9c1d-000000000002", "since": "2026-09-13T13:58:00Z", "frozenPids": [] },
    "lastTool": null },
  { "sessionId": "4d090000-3333-4b2b-9c1d-000000000003", "pid": null, "alive": true, "discovered": "transcript",
    "cwd": "/Users/alan/code/audioleveler", "transcriptPath": "/Users/alan/.claude/projects/-Users-alan-code-audioleveler/4d09.jsonl",
    "project": { "gitCommonDir": null, "name": "audioleveler" }, "worktree": null,
    "model": null, "startedAt": "2026-09-13T09:00:00Z", "lastActivityAt": "2026-09-13T09:40:00Z",
    "tokens": { "input": 520000, "output": 9000, "cacheCreate": 0, "cacheRead": 0, "messages": 30 }, "pause": null, "lastTool": null }
] }
```
`summary.json`:
```json
{ "limits": [
    { "id": "session", "kind": "session", "group": "session", "percent": 42, "severity": "normal", "resetsAt": "2026-09-13T16:35:00Z", "scope": null, "isActive": false },
    { "id": "weekly_all", "kind": "weekly_all", "group": "weekly", "percent": 81, "severity": "normal", "resetsAt": "2026-09-18T09:00:00Z", "scope": null, "isActive": true },
    { "id": "weekly_scoped:fable", "kind": "weekly_scoped", "group": "weekly", "percent": 10, "severity": "normal", "resetsAt": null, "scope": { "model": "fable", "surface": null }, "isActive": false } ],
  "status": { "byId": { "session": "ok", "weekly_all": "warn", "weekly_scoped:fable": "ok" }, "overall": "warn" },
  "thresholds": { "warn": 80, "critical": 95 },
  "today": { "input": 4200000, "output": 318000, "cacheCreate": 200000, "cacheRead": 9000000, "messages": 600 },
  "fetchedAt": "2026-09-13T14:00:00Z", "stale": false, "error": null }
```
`health.json` per daemon §15 with `update.state = "deferred"`, `deferredReason = "hard_frozen_sessions"`. `pause-rule.json`: `{ "rule": { "id": "r-9", "scope": "all", "mode": "soft", "reason": "usage-deck:abc", "createdAt": "2026-09-13T14:02:00Z", "createdBy": "dashboard" }, "affected": ["7f3a9c2e-1111-4b2b-9c1d-000000000001"] }`. `tokens-project.json`: `{ "ready": true, "since": "today", "groupBy": "project", "totals": {…}, "groups": [ { "key": "-Users-alan-code-calendarpa", "label": "/Users/alan/code/calendarpa", "input": 1600000, "output": 142000, "cacheCreate": 90000, "cacheRead": 4000000, "messages": 312 } ] }`. `error-401.json`: `{ "error": { "code": "unauthorized", "message": "Bearer token missing or invalid", "hint": "Re-run `claude-usage configure pairing` and scan again" } }`.

- [ ] **Step 1: Failing tests**

```kotlin
package com.evenseal.usagedeck.core.daemon
import com.evenseal.usagedeck.core.model.*
import kotlinx.serialization.decodeFromString
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class DtoTest {
    private fun fixture(name: String) = javaClass.getResource("/fixtures/$name")!!.readText()

    @Test fun `sessions fixture maps three sessions with pause and lastTool`() {
        val dto = DaemonJson.decodeFromString<SessionsDto>(fixture("sessions.json"))
        assertEquals(42L, dto.rev)
        val s = dto.sessions.map { it.toModel() }
        assertEquals(3, s.size)
        assertEquals("calendarpa", s[0].projectName)
        assertEquals("/Users/alan/code/calendarpa/.git", s[0].projectKey)
        assertEquals(LastTool("Read", Instant.parse("2026-09-13T14:01:58Z")), s[0].lastTool)
        assertEquals("billing", s[1].worktree)
        assertEquals(PauseMode.SOFT, s[1].pause!!.mode)
        assertEquals(Discovered.TRANSCRIPT, s[2].discovered)
        assertFalse(s[2].canHardPause)
        assertEquals("/Users/alan/code/audioleveler", s[2].projectKey) // null gitCommonDir falls back to cwd
    }
    @Test fun `summary fixture maps limits with status by id and null resetsAt`() {
        val dto = DaemonJson.decodeFromString<SummaryDto>(fixture("summary.json"))
        val limits = dto.toLimits()
        assertEquals(LimitStatus.WARN, limits.first { it.id == "weekly_all" }.status)
        assertNull(limits.first { it.id == "weekly_scoped:fable" }.resetsAt)
        assertEquals("fable", limits.first { it.id == "weekly_scoped:fable" }.scopeModel)
        assertEquals(4200000L, dto.today.toModel().input)
    }
    @Test fun `unknown limit status defaults to OK and unknown keys are ignored`() {
        val json = """{"limits":[{"id":"x","kind":"x","group":"g","percent":1,"severity":"weird","resetsAt":null,"scope":null,"isActive":false,"future":1}],"status":{"byId":{},"overall":"ok"},"today":{"input":0,"output":0,"cacheCreate":0,"cacheRead":0,"messages":0},"extra":true}"""
        val dto = DaemonJson.decodeFromString<SummaryDto>(json)
        assertEquals(LimitStatus.OK, dto.toLimits().single().status)
    }
    @Test fun `error envelope parses`() {
        val e = DaemonJson.decodeFromString<ErrorEnvelopeDto>(fixture("error-401.json")).error
        assertEquals("unauthorized", e.code); assertTrue(e.hint!!.startsWith("Re-run"))
    }
    @Test fun `pause response and tokens groups parse`() {
        val p = DaemonJson.decodeFromString<PauseResponseDto>(fixture("pause-rule.json"))
        assertEquals("usage-deck:abc", p.rule.toModel().reason)
        val t = DaemonJson.decodeFromString<TokensDto>(fixture("tokens-project.json"))
        assertEquals("/Users/alan/code/calendarpa", t.groups.single().toModel().label)
    }
}
```

- [ ] **Step 2: Run, expect compile failure** — `./gradlew :core:test --tests '*DtoTest*'`

- [ ] **Step 3: Implement `Dto.kt` and `Mapping.kt`**

```kotlin
package com.evenseal.usagedeck.core.daemon
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val DaemonJson = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false; coerceInputValues = true }

@Serializable data class TokensCountsDto(val input: Long = 0, val output: Long = 0, val cacheCreate: Long = 0, val cacheRead: Long = 0, val messages: Long = 0)
@Serializable data class UserDto(val emailAddress: String? = null, val accountUuid: String? = null, val organizationUuid: String? = null, val displayName: String? = null)
@Serializable data class UpdateDto(val channel: String = "stable", val current: String = "", val available: String? = null, val state: String = "idle", val deferredReason: String? = null)
@Serializable data class HealthDto(val ok: Boolean = true, val version: String = "", val uptimeMs: Long = 0, val pid: Int = 0, val name: String? = null, val user: UserDto? = null, val update: UpdateDto? = null)
@Serializable data class LimitScopeDto(val model: String? = null, val surface: String? = null)
@Serializable data class LimitDto(val id: String, val kind: String, val group: String = "", val percent: Int = 0, val severity: String = "normal", val resetsAt: String? = null, val scope: LimitScopeDto? = null, val isActive: Boolean = false)
@Serializable data class StatusDto(val byId: Map<String, String> = emptyMap(), val overall: String = "ok")
@Serializable data class SummaryDto(val limits: List<LimitDto> = emptyList(), val status: StatusDto = StatusDto(), val today: TokensCountsDto = TokensCountsDto(), val fetchedAt: String? = null, val stale: Boolean = false)
@Serializable data class ProjectRefDto(val gitCommonDir: String? = null, val name: String = "")
@Serializable data class PauseStateDto(val mode: String, val ruleId: String, val scope: String, val since: String, val frozenPids: List<Int> = emptyList())
@Serializable data class LastToolDto(val name: String, val at: String)
@Serializable data class SessionDto(
    val sessionId: String, val pid: Int? = null, val alive: Boolean = true, val discovered: String = "hook",
    val cwd: String, val transcriptPath: String? = null, val project: ProjectRefDto = ProjectRefDto(), val worktree: String? = null,
    val model: String? = null, val startedAt: String, val lastActivityAt: String, val tokens: TokensCountsDto = TokensCountsDto(),
    val pause: PauseStateDto? = null, val lastTool: LastToolDto? = null,
)
@Serializable data class SessionsDto(val rev: Long = 0, val sessions: List<SessionDto> = emptyList())
@Serializable data class PauseRuleDto(val id: String, val scope: String, val mode: String, val reason: String? = null, val createdAt: String, val createdBy: String = "")
@Serializable data class PauseResponseDto(val rule: PauseRuleDto, val affected: List<String> = emptyList())
@Serializable data class ResumeResponseDto(val removed: List<String> = emptyList(), val resumed: List<String> = emptyList())
@Serializable data class RulesDto(val rev: Long = 0, val rules: List<PauseRuleDto> = emptyList())
@Serializable data class TokensGroupDto(val key: String, val label: String = "", val input: Long = 0, val output: Long = 0, val cacheCreate: Long = 0, val cacheRead: Long = 0, val messages: Long = 0)
@Serializable data class TokensDto(val ready: Boolean = true, val groups: List<TokensGroupDto> = emptyList())
@Serializable data class ErrorBodyDto(val code: String, val message: String? = null, val hint: String? = null)
@Serializable data class ErrorEnvelopeDto(val error: ErrorBodyDto)
@Serializable data class PauseRequestDto(val scope: String, val mode: String, val reason: String)
@Serializable data class ResumeRequestDto(val scope: String)
```
`Mapping.kt`:
```kotlin
package com.evenseal.usagedeck.core.daemon
import com.evenseal.usagedeck.core.model.*
import java.time.Instant

internal fun String?.toInstantOrNull(): Instant? = this?.let { runCatching { Instant.parse(it) }.getOrNull() }
internal fun String.toInstantOr(default: Instant): Instant = toInstantOrNull() ?: default
fun TokensCountsDto.toModel() = Tokens(input, output, cacheCreate, cacheRead, messages)
fun TokensGroupDto.toModel() = ProjectTokens(key, label, Tokens(input, output, cacheCreate, cacheRead, messages))
fun UserDto.toModel() = User(emailAddress, accountUuid, displayName)
fun UpdateDto.toModel() = UpdateState(channel, current, available, state, deferredReason)
fun statusOf(s: String?): LimitStatus = when (s?.lowercase()) { "warn" -> LimitStatus.WARN; "critical" -> LimitStatus.CRITICAL; else -> LimitStatus.OK }
fun LimitDto.toModel(status: LimitStatus) = Limit(id, kind, group, percent, severity, resetsAt.toInstantOrNull(), scope?.model, isActive, status)
fun SummaryDto.toLimits(): List<Limit> = limits.map { it.toModel(statusOf(status.byId[it.id])) }
fun PauseStateDto.toModel() = PauseState(if (mode == "hard") PauseMode.HARD else PauseMode.SOFT, ruleId, scope, since.toInstantOr(Instant.EPOCH), frozenPids)
fun PauseRuleDto.toModel() = PauseRule(id, scope, if (mode == "hard") PauseMode.HARD else PauseMode.SOFT, reason, createdAt.toInstantOr(Instant.EPOCH), createdBy)
fun SessionDto.toModel() = Session(
    sessionId = sessionId, pid = pid, alive = alive,
    discovered = if (discovered == "transcript") Discovered.TRANSCRIPT else Discovered.HOOK,
    cwd = cwd, transcriptPath = transcriptPath,
    projectKey = project.gitCommonDir ?: cwd, projectName = project.name.ifBlank { cwd.substringAfterLast('/') },
    worktree = worktree, model = model,
    startedAt = startedAt.toInstantOr(Instant.EPOCH), lastActivityAt = lastActivityAt.toInstantOr(Instant.EPOCH),
    tokens = tokens.toModel(), pause = pause?.toModel(), lastTool = lastTool?.let { LastTool(it.name, it.at.toInstantOr(Instant.EPOCH)) },
)
```

- [ ] **Step 4: Run tests, expect PASS.** `./gradlew :core:test --tests '*DtoTest*'`
- [ ] **Step 5: Commit** `feat(core): daemon DTOs, mappers and fixtures`

---

### Task 3: Errors and REST `DaemonApi` over OkHttp

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/daemon/Errors.kt`, `DaemonApi.kt`
- Test: `core/src/test/kotlin/com/evenseal/usagedeck/core/daemon/DaemonApiTest.kt`

**Interfaces (Produces):**
```kotlin
class DaemonException(val code: String, val httpStatus: Int, message: String?, val hint: String?) : Exception(message) {
    fun userMessage(): String = hint ?: message ?: DEFAULTS[code] ?: "Daemon error ($code)"
    companion object { val DEFAULTS = mapOf(
        "unauthorized" to "Token rejected. Re-run pairing on the Mac.",
        "network" to "Machine unreachable.",
        "not_found" to "Session no longer exists.",
        "conflict" to "That session can't be hard-paused (no trusted pid).",
        "gone" to "Session ended; pause cleared.") }
}
sealed interface SessionsResult { data class Changed(val dto: SessionsDto, val etag: String?) : SessionsResult; object Unchanged : SessionsResult }
interface DaemonApi {
    suspend fun health(): HealthDto
    suspend fun summary(): SummaryDto
    suspend fun sessions(ifNoneMatch: String?): SessionsResult
    suspend fun tokensByProjectToday(): TokensDto
    suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto
    suspend fun resume(scope: String): ResumeResponseDto
    suspend fun rules(): RulesDto
}
class OkHttpDaemonApi(private val config: MachineConfig, private val client: OkHttpClient) : DaemonApi
```
Every request sends `Authorization: Bearer ${config.token}` and `Accept: application/json`. Non-2xx → parse `ErrorEnvelopeDto` if body is JSON else `DaemonException(code = when(status){401->"unauthorized";404->"not_found";409->"conflict";410->"gone";else->"http_$status"}, …)`. IOException → `DaemonException("network", 0, e.message, null)`. Timeouts: connect 2 s, read 5 s, call 6 s.

- [ ] **Step 1: Failing tests with MockWebServer**

```kotlin
class DaemonApiTest {
    private val server = MockWebServer()
    private lateinit var api: DaemonApi
    @Before fun up() { server.start(); api = OkHttpDaemonApi(MachineConfig("m", "n", server.hostName, server.port, "tok"), OkHttpClient()) }
    @After fun down() = server.shutdown()
    private fun fixture(n: String) = javaClass.getResource("/fixtures/$n")!!.readText()

    @Test fun `sends bearer token and parses sessions with etag`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("sessions.json")).addHeader("ETag", "W/\"42\""))
        val r = api.sessions(null) as SessionsResult.Changed
        assertEquals("W/\"42\"", r.etag); assertEquals(3, r.dto.sessions.size)
        val req = server.takeRequest()
        assertEquals("Bearer tok", req.getHeader("Authorization")); assertEquals("/v1/sessions", req.path)
    }
    @Test fun `304 yields Unchanged and sends If-None-Match`() = runTest {
        server.enqueue(MockResponse().setResponseCode(304))
        assertEquals(SessionsResult.Unchanged, api.sessions("W/\"42\""))
        assertEquals("W/\"42\"", server.takeRequest().getHeader("If-None-Match"))
    }
    @Test fun `401 envelope becomes DaemonException with hint`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody(fixture("error-401.json")))
        val e = assertThrows(DaemonException::class.java) { runBlocking { api.summary() } }
        assertEquals("unauthorized", e.code); assertTrue(e.userMessage().startsWith("Re-run"))
    }
    @Test fun `non-json 500 falls back to code default`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))
        val e = assertThrows(DaemonException::class.java) { runBlocking { api.health() } }
        assertEquals("http_500", e.code); assertEquals("Daemon error (http_500)", e.userMessage())
    }
    @Test fun `pause posts json body to v1 pause`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("pause-rule.json")))
        api.pause("all", PauseMode.SOFT, "usage-deck:abc")
        val req = server.takeRequest()
        assertEquals("/v1/pause", req.path); assertEquals("POST", req.method)
        assertEquals("""{"scope":"all","mode":"soft","reason":"usage-deck:abc"}""", req.body.readUtf8())
    }
    @Test fun `tokens uses groupBy project since today`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("tokens-project.json")))
        api.tokensByProjectToday()
        assertEquals("/v1/tokens?since=today&groupBy=project", server.takeRequest().path)
    }
    @Test fun `connection refused is a network error`() = runTest {
        server.shutdown()
        val e = assertThrows(DaemonException::class.java) { runBlocking { api.health() } }
        assertEquals("network", e.code)
    }
}
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** `OkHttpDaemonApi` with a private `suspend fun <T> call(req: Request, parse: (String) -> T): T` using `withContext(Dispatchers.IO)` + `client.newCall(req).execute()`; `sessions` special-cases 304. Build the client per instance: `client.newBuilder().connectTimeout(2, SECONDS).readTimeout(5, SECONDS).callTimeout(6, SECONDS).build()`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): REST DaemonApi with bearer auth and error envelope`

---

### Task 4: SSE events — `DaemonEvent`, parser, OkHttp EventSource wrapper

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/daemon/SseEvents.kt`, `EventSource.kt`
- Test: `core/src/test/kotlin/com/evenseal/usagedeck/core/daemon/SseEventsTest.kt`, `EventSourceTest.kt`

**Interfaces (Produces):**
```kotlin
sealed interface DaemonEvent {
    data class Snapshot(val name: String?, val version: String?, val user: UserDto?, val limits: List<LimitDto>, val status: StatusDto, val today: TokensCountsDto, val sessions: List<SessionDto>, val rules: List<PauseRuleDto>, val update: UpdateDto?, val rev: Long) : DaemonEvent
    data class Limits(val limits: List<LimitDto>, val status: StatusDto) : DaemonEvent
    data class Spend(val today: TokensCountsDto, val delta: TokensCountsDto) : DaemonEvent
    data class SessionChange(val type: String, val session: SessionDto) : DaemonEvent   // type: start|end|update
    data class Pause(val rules: List<PauseRuleDto>, val affected: List<String>) : DaemonEvent
    data class Update(val update: UpdateDto) : DaemonEvent
    object Heartbeat : DaemonEvent
    data class Unknown(val event: String) : DaemonEvent
}
object SseParser { fun parse(event: String?, data: String): DaemonEvent }   // never throws; malformed → Unknown
sealed interface Connection { object Open : Connection; data class Closed(val error: DaemonException?) : Connection }
class DaemonEventSource(private val config: MachineConfig, private val client: OkHttpClient) {
    /** Emits Connection.Open, then events, then Connection.Closed; completes when closed. One connection per collect. */
    fun events(): Flow<Any>   // elements are DaemonEvent or Connection
}
```
The `snapshot` data shape (daemon §19): `{ name, version, user, limits: { limits:[…], status:{…}, … } | [ … ], summary: { limits, status, today, … }, sessions: { rev, sessions:[…] }, rules: [ … ] | { rules:[…] }, update, rev }`. Read `summary.limits`, `summary.status`, `summary.today`, `sessions.sessions`; accept `rules` as either array or `{rules}`. Define `@Serializable data class SnapshotDto(...)` accordingly with a custom handling for `rules` via `JsonElement`.

- [ ] **Step 1: Failing parser tests**

```kotlin
class SseEventsTest {
    @Test fun `heartbeat parses with empty data`() { assertEquals(DaemonEvent.Heartbeat, SseParser.parse("heartbeat", "")) }
    @Test fun `session event parses type and session`() {
        val e = SseParser.parse("session", """{"type":"update","session":{"sessionId":"s1","cwd":"/x","startedAt":"2026-09-13T11:20:00Z","lastActivityAt":"2026-09-13T11:21:00Z"}}""") as DaemonEvent.SessionChange
        assertEquals("update", e.type); assertEquals("s1", e.session.sessionId)
    }
    @Test fun `spend event parses today and delta`() {
        val e = SseParser.parse("spend", """{"today":{"input":10},"delta":{"input":2}}""") as DaemonEvent.Spend
        assertEquals(2L, e.delta.input)
    }
    @Test fun `snapshot parses nested summary and sessions and rules array`() {
        val json = """{"name":"alans-mbp","version":"0.1.5+abc","user":{"emailAddress":"a@b"},
          "summary":{"limits":[{"id":"session","kind":"session","percent":42}],"status":{"byId":{"session":"ok"},"overall":"ok"},"today":{"input":1}},
          "sessions":{"rev":7,"sessions":[]},"rules":[{"id":"r","scope":"all","mode":"soft","createdAt":"2026-09-13T00:00:00Z"}],"update":{"state":"idle"},"rev":7}"""
        val s = SseParser.parse("snapshot", json) as DaemonEvent.Snapshot
        assertEquals("alans-mbp", s.name); assertEquals(42, s.limits.single().percent); assertEquals(1, s.rules.size); assertEquals(7L, s.rev)
    }
    @Test fun `snapshot accepts rules wrapped in object`() {
        val s = SseParser.parse("snapshot", """{"summary":{},"sessions":{},"rules":{"rev":1,"rules":[]},"rev":1}""") as DaemonEvent.Snapshot
        assertTrue(s.rules.isEmpty())
    }
    @Test fun `malformed data yields Unknown not exception`() { assertTrue(SseParser.parse("session", "{not json") is DaemonEvent.Unknown) }
    @Test fun `unknown event name yields Unknown`() { assertEquals(DaemonEvent.Unknown("zebra"), SseParser.parse("zebra", "{}")) }
}
```
And `EventSourceTest` using MockWebServer with a chunked `text/event-stream` body:
```kotlin
@Test fun `emits Open then parsed events then Closed`() = runTest {
    val body = "id: 1\nevent: snapshot\ndata: {\"summary\":{},\"sessions\":{},\"rules\":[],\"rev\":1}\n\nevent: heartbeat\ndata: {}\n\n"
    server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body))
    val items = DaemonEventSource(cfg, OkHttpClient()).events().toList()
    assertEquals(Connection.Open, items[0]); assertTrue(items[1] is DaemonEvent.Snapshot); assertEquals(DaemonEvent.Heartbeat, items[2]); assertTrue(items.last() is Connection.Closed)
    assertEquals("Bearer tok", server.takeRequest().getHeader("Authorization"))
}
@Test fun `401 closes with unauthorized`() = runTest {
    server.enqueue(MockResponse().setResponseCode(401).setBody(fixture("error-401.json")))
    val last = DaemonEventSource(cfg, OkHttpClient()).events().toList().last() as Connection.Closed
    assertEquals("unauthorized", last.error!!.code)
}
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** `SseParser.parse` = `runCatching { when(event) {...} }.getOrElse { DaemonEvent.Unknown(event ?: "") }`. `DaemonEventSource.events()` = `callbackFlow` around `EventSources.createFactory(client).newEventSource(request, listener)`; `onOpen → trySend(Open)`, `onEvent → trySend(SseParser.parse(type, data))`, `onFailure(t, response) → trySend(Closed(toDaemonException(t, response))); close()`, `onClosed → trySend(Closed(null)); close()`; `awaitClose { es.cancel() }`. Client for SSE: `readTimeout(0)` (no read timeout; heartbeat watchdog lives in MachineClient), `connectTimeout(3 s)`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): SSE event parser and OkHttp event source`

---

### Task 5: `BurnHistory` and `Aging`

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/model/BurnHistory.kt`, `Aging.kt`
- Test: `core/src/test/kotlin/com/evenseal/usagedeck/core/model/BurnHistoryTest.kt`, `AgingTest.kt`

**Interfaces (Produces):**
```kotlin
class BurnHistory(private val retention: Duration = Duration.ofHours(5), private val maxPoints: Int = 2000) {
    data class Point(val at: Instant, val cumulative: Long)
    fun record(key: String, at: Instant, cumulative: Long)           // ignores non-monotonic drops (treat as restart → new baseline)
    fun ratePerMinute(key: String, now: Instant, window: Duration = Duration.ofSeconds(60)): Double
    fun series(key: String, now: Instant, window: Duration, buckets: Int): List<Double>  // tokens/min per bucket, oldest first, 0.0 for empty
    fun forget(key: String)
}
object Aging {
    val FRESH: Duration = Duration.ofSeconds(30); val DEAD: Duration = Duration.ofSeconds(120)
    fun health(lastHeartbeatAt: Instant?, now: Instant): Health
}
```

- [ ] **Step 1: Failing tests**

```kotlin
class BurnHistoryTest {
    private val t0 = Instant.parse("2026-09-13T14:00:00Z")
    @Test fun `rate over 60s window from two samples`() {
        val h = BurnHistory(); h.record("s", t0, 1000); h.record("s", t0.plusSeconds(60), 4000)
        assertEquals(3000.0, h.ratePerMinute("s", t0.plusSeconds(60)), 0.01)
    }
    @Test fun `rate is zero with a single sample`() { val h = BurnHistory(); h.record("s", t0, 1000); assertEquals(0.0, h.ratePerMinute("s", t0), 0.0) }
    @Test fun `series buckets tokens per minute oldest first`() {
        val h = BurnHistory()
        for (i in 0..10) h.record("s", t0.plusSeconds(i * 60L), i * 600L)   // 600 tokens/min steady
        val s = h.series("s", t0.plusSeconds(600), Duration.ofMinutes(10), 5)
        assertEquals(5, s.size); s.forEach { assertEquals(600.0, it, 1.0) }
    }
    @Test fun `cumulative drop resets baseline instead of negative rate`() {
        val h = BurnHistory(); h.record("s", t0, 5000); h.record("s", t0.plusSeconds(30), 100); h.record("s", t0.plusSeconds(60), 400)
        assertTrue(h.ratePerMinute("s", t0.plusSeconds(60)) >= 0.0)
    }
    @Test fun `points older than retention are dropped`() {
        val h = BurnHistory(retention = Duration.ofMinutes(1)); h.record("s", t0, 1); h.record("s", t0.plusSeconds(120), 2)
        assertEquals(0.0, h.ratePerMinute("s", t0.plusSeconds(120)), 0.0)  // only one point survives
    }
}
class AgingTest {
    private val now = Instant.parse("2026-09-13T14:00:00Z")
    @Test fun `null heartbeat is dead`() = assertEquals(Health.DEAD, Aging.health(null, now))
    @Test fun `29s is fresh 30s is stale 120s is dead`() {
        assertEquals(Health.FRESH, Aging.health(now.minusSeconds(29), now))
        assertEquals(Health.STALE, Aging.health(now.minusSeconds(30), now))
        assertEquals(Health.STALE, Aging.health(now.minusSeconds(119), now))
        assertEquals(Health.DEAD, Aging.health(now.minusSeconds(120), now))
    }
}
```

- [ ] **Step 2: Run, expect failure.** **Step 3: Implement** (ArrayDeque per key; on drop, clear the key's deque before recording; `series` = for each bucket, rate between the last point ≤ bucket end and the last point ≤ bucket start, ×60/bucketSeconds). **Step 4: PASS.** **Step 5: Commit** `feat(core): burn history and heartbeat aging`

---

### Task 6: `MachineClient` — one machine's live state

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/daemon/MachineClient.kt`
- Test: `core/src/test/kotlin/com/evenseal/usagedeck/core/daemon/MachineClientTest.kt`

**Interfaces:**
- Consumes: `DaemonApi`, `DaemonEventSource` (via a factory so tests inject fakes), `BurnHistory`, `Aging`, `Clock`.
- Produces:
```kotlin
class MachineClient(
    val config: MachineConfig,
    private val api: DaemonApi,
    private val eventSource: () -> Flow<Any>,         // DaemonEventSource(config, client)::events
    private val burn: BurnHistory,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val screenOn: StateFlow<Boolean>,          // drives 2 s vs 30 s polling
    private val tickerMs: Long = 1000,
) {
    val state: StateFlow<MachineState>
    fun start(); fun stop()
    suspend fun refreshProjectTokens()                 // GET /v1/tokens; called every 30 s while started
    fun burnKeyForSession(sessionId: String) = "${config.id}/s/$sessionId"
    fun burnKeyForProject(projectKey: String) = "${config.id}/p/$projectKey"
    fun burnKeyForMachine() = "${config.id}/m"
}
```
Behaviour (spec §7): loop = connect SSE; on `Snapshot` replace `name, version, user, limits(+status), limitsFetchedAt=now, today, sessions, rules, update, rev`, set `transport=SSE`, `lastHeartbeatAt=now`; every event (incl. heartbeat) bumps `lastHeartbeatAt`. `Limits` → replace limits. `Spend` → `today = spend.today`, record machine burn with cumulative `today.total`. `SessionChange start/update` → upsert by sessionId and record session burn (`tokens.total`) plus project burn (sum of that project's session totals); `end` → remove. `Pause` → `rules = event.rules`, and re-fetch sessions once (`api.sessions(null)`) because pause state lives on sessions. `Update` → replace. On `Closed(error)`: `lastError = error?.userMessage()`, `transport = DISCONNECTED`; after two consecutive failed connects switch to `POLLING`: every `if (screenOn) 2 s else 30 s` call `summary()` and `sessions(etag)`; every backoff tick (3 s → 6 → 12 → 30 max) retry SSE and on `Open` return to SSE. A 1 s ticker recomputes `health = Aging.health(lastHeartbeatAt, now)`. Every 30 s while started call `refreshProjectTokens()` (`projectTokens = dto.groups.map{toModel}`; errors ignored). Errors never crash; they land in `lastError`.

- [ ] **Step 1: Failing tests** with a `FakeApi : DaemonApi` (records calls, scriptable results) and a `MutableSharedFlow<Any>` fed as the event source, `FakeClock`, `runTest` + `advanceTimeBy`:
```kotlin
@Test fun `snapshot populates state and marks SSE`()
@Test fun `heartbeat refreshes lastHeartbeatAt and health goes fresh`()
@Test fun `no heartbeat for 120s marks dead`()               // advance clock and ticker
@Test fun `session update upserts and records burn`()        // then ratePerMinute > 0 after second update 60s later
@Test fun `session end removes`()
@Test fun `spend replaces today total`()
@Test fun `pause event replaces rules and refetches sessions`()
@Test fun `two failed connects switch to polling and poll summary and sessions with etag`()
@Test fun `polling interval is 2s when screen on and 30s when off`()
@Test fun `successful reconnect returns to SSE and replaces state from snapshot`()
@Test fun `project tokens refresh every 30s`()
```
Each test asserts on `client.state.value` fields and `fakeApi.calls`.

- [ ] **Step 2: Run, expect failure. Step 3: Implement. Step 4: PASS. Step 5: Commit** `feat(core): MachineClient with SSE, polling fallback and aging`

---

### Task 7: `TeamState` merge

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/model/TeamState.kt`
- Test: `core/src/test/kotlin/com/evenseal/usagedeck/core/model/TeamStateTest.kt`

**Interfaces (Produces):**
```kotlin
data class UserView(val key: String /* accountUuid ?: emailAddress ?: machineId */, val displayName: String, val emailAddress: String?, val machineIds: List<String>, val limits: List<Limit>, val limitsFetchedAt: Instant?, val health: Health /* best of its machines */) {
    val fiveHour: Limit? get() = limits.firstOrNull { it.id == "session" }
    val sevenDay: Limit? get() = limits.firstOrNull { it.id == "weekly_all" }
    val scoped: List<Limit> get() = limits.filter { it.kind == "weekly_scoped" }
}
data class ProjectView(val machineId: String, val key: String, val name: String, val sessions: List<Session>, val todayTokens: Tokens?, val worktreeCount: Int) {
    val liveTokens: Tokens get() = sessions.fold(Tokens.ZERO) { a, s -> a + s.tokens }
    val isIdle: Boolean get() = sessions.none { it.alive }
    val pause: PauseState? get() = sessions.mapNotNull { it.pause }.maxByOrNull { it.mode.ordinal }  // HARD wins
}
data class TeamState(val machines: List<MachineState>) {
    val users: List<UserView>
    val projects: List<ProjectView>          // live first (sorted by liveTokens desc), then idle (by todayTokens desc)
    val liveSessionCount: Int
    val teamToday: Tokens
    fun machine(id: String): MachineState?
    fun session(machineId: String, sessionId: String): Session?
}
```
Rules: two machines with the same `accountUuid` collapse into one `UserView` whose `limits` come from the machine with the newest `limitsFetchedAt`. Idle projects come from `projectTokens` entries whose `label` (cwd) matches no live session cwd; their `key` is the label, name is `label.substringAfterLast('/')`. `todayTokens` for a live project = the `projectTokens` entry whose label equals any of its sessions' cwd (sum if several worktrees match different entries).

- [ ] **Step 1: Failing tests** covering: same-user dedupe with freshest limits winning; two different users; worktree grouping (two sessions, same projectKey → one project, `worktreeCount = 2`); idle project appears after live ones; `pause` HARD wins over SOFT; `teamToday` sums both machines. **Step 2–4:** fail, implement, pass. **Step 5: Commit** `feat(core): TeamState merge of machines into users and projects`

---

### Task 8: `PauseController` with escalation

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/pause/PauseTarget.kt`, `EscalationStore.kt`, `PauseController.kt`
- Test: `core/src/test/kotlin/com/evenseal/usagedeck/core/pause/PauseControllerTest.kt`

**Interfaces (Produces):**
```kotlin
sealed interface PauseTarget {
    data class Session(val machineId: String, val sessionId: String) : PauseTarget
    data class Project(val machineId: String, val projectKey: String) : PauseTarget
    object All : PauseTarget
    fun scope(): String = when (this) { is Session -> "session:$sessionId"; is Project -> "project:$projectKey"; All -> "all" }
}
data class Escalation(val machineId: String, val scope: String, val fireAt: Instant)
interface EscalationStore { fun load(): List<Escalation>; fun save(list: List<Escalation>) }
class InMemoryEscalationStore : EscalationStore
data class PauseOutcome(val machineId: String, val ok: Boolean, val error: String?)
data class PauseSettings(val escalationSeconds: Int? = 90)   // null = off; valid 30..600

class PauseController(
    private val team: StateFlow<TeamState>,
    private val apis: (machineId: String) -> DaemonApi?,
    private val installId: String,
    private val store: EscalationStore,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val settings: StateFlow<PauseSettings>,
) {
    val reason: String = "usage-deck:$installId"
    val pending: StateFlow<List<Escalation>>
    val inFlight: StateFlow<Set<String>>                 // "machineId|scope" keys with a request in flight
    val lastOutcomes: StateFlow<List<PauseOutcome>>      // from the most recent All fan-out
    fun start()                                          // restores store, starts timer loop
    suspend fun tap(target: PauseTarget)                 // paused? resume : soft
    suspend fun hold(target: PauseTarget)                // hard
    suspend fun soft(target: PauseTarget): List<PauseOutcome>
    suspend fun hard(target: PauseTarget): List<PauseOutcome>
    suspend fun resume(target: PauseTarget): List<PauseOutcome>
    fun isPaused(target: PauseTarget): Boolean           // from team state rules/sessions
    fun escalationFor(target: PauseTarget): Escalation?
}
```
Semantics: `soft` on Session/Project → one machine; on All → every machine whose `health != DEAD`, each with one retry after 2 s on failure; outcomes collected. After a successful soft **with** `settings.escalationSeconds != null`, add `Escalation(machineId, scope, now + n)` and persist. The timer loop (every 1 s) fires due escalations: call `hard` for that (machine, scope), remove from store. An escalation is cancelled (removed + persisted) when: `resume` is called for the scope; the team state no longer contains a rule with that scope **and** `reason == this.reason` on that machine; or the machine is DEAD at fire time (dropped, not retried). `hard` on a `Session` target whose `canHardPause == false` returns an outcome `ok=false, error = DaemonException.DEFAULTS["conflict"]` without calling the API. `tap` decides using `isPaused`.

- [ ] **Step 1: Failing tests** (FakeApi per machine, `MutableStateFlow<TeamState>` you mutate to simulate SSE `pause` events):
```kotlin
@Test fun `soft session posts to owning machine with install reason`()
@Test fun `soft schedules escalation and hard fires after 90s`()
@Test fun `resume cancels pending escalation`()
@Test fun `rule vanishing from team state cancels escalation`()
@Test fun `foreign soft pause does not escalate`()             // rule.reason = "cli"
@Test fun `escalation off disables scheduling`()
@Test fun `all fans out to fresh machines only and retries once`()
@Test fun `hard on transcript-discovered session is refused locally`()
@Test fun `tap on paused target resumes`()
@Test fun `pending escalations restore from store and overdue fire immediately`()
@Test fun `409 from daemon surfaces user message`()
```
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(core): PauseController with soft→hard escalation and fan-out`

---

### Task 9: `AlertEvaluator` and `update/`

**Files:**
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/alerts/AlertEvaluator.kt`
- Create: `core/src/main/kotlin/com/evenseal/usagedeck/core/update/Version.kt`, `ReleaseChecker.kt`
- Test: `AlertEvaluatorTest.kt`, `VersionTest.kt`, `ReleaseCheckerTest.kt`

**Interfaces (Produces):**
```kotlin
enum class AlertKind { WARN, CRITICAL, FROZEN, UNREACHABLE }
data class Alert(val kind: AlertKind, val key: String /* dedupe: "$kind|$userKey|$limitId" or "$kind|$machineId" or "$kind|$machineId|$sessionId" */, val title: String, val body: String)
data class AlertThresholds(val warn: Int = 80, val critical: Int = 95)
class AlertEvaluator(private val thresholds: StateFlow<AlertThresholds>) {
    /** Pure. Compares prev→next and returns alerts to raise now. Caller handles quiet hours and the 10-min critical repeat. */
    fun evaluate(prev: TeamState?, next: TeamState): List<Alert>
}
data class Version(val major: Int, val minor: Int, val build: Int, val sha: String) : Comparable<Version> {
    companion object { fun parse(s: String): Version?  /* accepts "v0.1.417+3f9c2ab", "0.1.417+3f9c2ab", "0.1.417" */ }
}
data class ReleaseInfo(val version: Version, val apkUrl: String, val sumsUrl: String, val apkName: String)
class ReleaseChecker(private val repo: String, private val client: OkHttpClient, private val apkPrefix: String = "usage-deck-") {
    suspend fun latest(): ReleaseInfo?         // GET https://api.github.com/repos/$repo/releases/latest; null if no matching asset
    suspend fun expectedSha256(info: ReleaseInfo): String?   // parse SHA256SUMS for apkName
    fun isNewer(candidate: Version, installed: Version) = candidate > installed
}
object Sha256 { fun hex(bytes: ByteArray): String; fun hexOf(file: java.io.File): String }
```
Alert rules: WARN when a user's limit crosses from `< warn` to `≥ warn` (or first seen ≥ warn and `< critical`); CRITICAL when crossing `≥ critical`; FROZEN when a session's `pause?.mode` becomes HARD (from anything else); UNREACHABLE when a machine's health becomes DEAD from FRESH/STALE (not from initial null/DEAD). Bodies: `"Alan 7-day at 81% · resets Thu 09:00"` style using `displayName ?: emailAddress ?: machine name` and the limit id mapped `session→"5-hour"`, `weekly_all→"7-day"`, else the scoped model name. `resetsAt == null` → `"resets: unknown"`.

- [ ] **Step 1: Failing tests** for each rule, plus `Version` parse/compare (`0.1.418+abc > 0.1.417+zzz`; `parse("garbage") == null`; leading `v` accepted), plus `ReleaseChecker` against MockWebServer with a GitHub-shaped JSON `{ "tag_name":"v0.1.418+abc", "assets":[{"name":"usage-deck-0.1.418+abc.apk","browser_download_url":"…"},{"name":"SHA256SUMS","browser_download_url":"…"}] }` and a SUMS body `"<hex>  usage-deck-0.1.418+abc.apk\n"`. **Steps 2–4.** **Step 5: Commit** `feat(core): alert evaluator, version compare and release checker`

---

### Task 10: `fakedaemon` — Ktor implementation of the contract

**Files:**
- Create: `fakedaemon/src/main/kotlin/com/evenseal/usagedeck/fakedaemon/FakeDaemon.kt`, `Scenarios.kt`, replace `Main.kt`
- Test: `fakedaemon/src/test/kotlin/com/evenseal/usagedeck/fakedaemon/FakeDaemonTest.kt`

**Interfaces (Produces):**
```kotlin
class FakeDaemon(val port: Int, val token: String = "fake-token", val name: String = "fake-mbp", scenario: Scenario = Scenarios.idle) {
    fun start(); fun stop()
    val state: FakeState                                 // mutable: limits, sessions, rules, today, update
    fun emit(event: String, data: String)                // push to all SSE clients
    fun tick()                                           // advance scenario one step (called by scheduler every 2 s)
}
interface Scenario { val name: String; fun init(s: FakeState); fun step(s: FakeState, n: Int, emit: (String, String) -> Unit) }
object Scenarios { val idle: Scenario; val warnCrossing: Scenario; val freeze: Scenario; val machineDrop: Scenario; fun byName(n: String): Scenario }
```
Routes (daemon §15–§19, §23): `GET /health`, `GET /v1/summary`, `GET /v1/sessions` (ETag `W/"<rev>"`, 304 on match), `GET /v1/tokens` (`groupBy=project` only), `POST /v1/pause` (rules map, idempotent; `session:` on a `discovered=transcript` session → 409; unknown session → 410), `POST /v1/resume`, `GET /v1/pause/rules`, `DELETE /v1/pause/rules/{id}`, `GET /v1/events` (snapshot then heartbeat every 15 s, plus scenario emits). All non-loopback or non-GET require `Authorization: Bearer <token>` else 401 with the envelope. `Main.kt` args: `--port 47291 --scenario warnCrossing --token …`. Session data seeded from the Task 2 fixtures. `warnCrossing`: every step +3 % on `weekly_all` from 70 → 97, status flips at 80/95. `freeze`: at step 3 marks session 1 `pause = hard` and emits `pause` + `session update`. `machineDrop`: stops heartbeats after step 5 for 3 minutes, then resumes.

- [ ] **Step 1: Failing tests** hitting the real Ktor server via OkHttp: health ok; sessions ETag → 304; pause idempotent; 409 on transcript session; 401 without token on POST; SSE first event is `snapshot`. **Steps 2–4.** **Step 5: Commit** `feat(fakedaemon): Ktor daemon stub with scripted scenarios`

---

## Track B — app

### Task 11: Kiosk — Device Owner receiver, lock task, mode controller, exit PIN

**Files:**
- Modify: `app/src/main/AndroidManifest.xml`
- Create: `app/src/main/res/xml/device_admin.xml`, `app/src/main/kotlin/com/evenseal/usagedeck/kiosk/DeviceAdminReceiver.kt`, `KioskManager.kt`, `ModeController.kt`, `ExitPin.kt`
- Test: `app/src/test/kotlin/com/evenseal/usagedeck/kiosk/ExitPinTest.kt`, `ModeControllerTest.kt` (Robolectric)

**Interfaces (Produces):**
```kotlin
class DeviceAdminReceiver : android.app.admin.DeviceAdminReceiver()
class KioskManager(private val context: Context) {
    val isDeviceOwner: Boolean
    fun applyPolicies()
    // If owner: setLockTaskPackages(admin, [self, "com.tailscale.ipn"]); setLockTaskFeatures(admin, LOCK_TASK_FEATURE_NONE);
    // setKeyguardDisabled(admin, true); setGlobalSetting(admin, STAY_ON_WHILE_PLUGGED_IN, "7"); setStatusBarDisabled(admin, true);
    // addUserRestriction(admin, DISALLOW_SAFE_BOOT);
    // addPersistentPreferredActivity(admin, IntentFilter(ACTION_MAIN + CATEGORY_HOME + CATEGORY_DEFAULT), ComponentName(self, MainActivity)).
    // Doze exemption: Device Owner cannot write that setting directly on API 29, so on first run launch
    // ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS once (one tap, documented in device-setup.md) and expose `dozeExempt`.
    fun startLockTask(activity: Activity)   // only if isDeviceOwner and not already in lock task
    fun stopLockTask(activity: Activity)
    val dozeExempt: Boolean
}
enum class DeckMode { DOCK, BATTERY }
class ModeController(context: Context) { val mode: StateFlow<DeckMode>; val screenOn: StateFlow<Boolean>; fun start(); fun stop() }   // ACTION_POWER_CONNECTED/DISCONNECTED + ACTION_SCREEN_ON/OFF receivers; initial from BatteryManager
class ExitPin(private val prefs: SharedPreferences /* Encrypted */, private val clock: Clock) {
    fun isSet(): Boolean; fun set(pin: String)                      // 6 digits; stores salt + SHA-256(salt+pin)
    sealed interface Result { object Ok : Result; data class Wrong(val remaining: Int) : Result; data class LockedOut(val until: Instant) : Result }
    fun verify(pin: String): Result                                  // 5 wrong → lockout 5 min, doubling each round; success resets
}
```
Manifest additions: `<receiver android:name=".kiosk.DeviceAdminReceiver" android:permission="android.permission.BIND_DEVICE_ADMIN" android:exported="true"><meta-data android:name="android.app.device_admin" android:resource="@xml/device_admin"/><intent-filter><action android:name="android.app.action.DEVICE_ADMIN_ENABLED"/></intent-filter></receiver>`; MainActivity gets `<category android:name="android.intent.category.HOME"/>` and `DEFAULT` so it can be the launcher, plus `android:lockTaskMode="if_whitelisted"`, `android:screenOrientation="sensor"`. Permissions: `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `FOREGROUND_SERVICE`, `RECEIVE_BOOT_COMPLETED`, `VIBRATE`, `CAMERA`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`, `ACCESS_FINE_LOCATION` (scan results on 29), `ACCESS_NETWORK_STATE`, `REQUEST_INSTALL_PACKAGES`, `WAKE_LOCK`, `SCHEDULE_EXACT_ALARM` is not on 29 (skip). `device_admin.xml`: `<device-admin><uses-policies><force-lock/><disable-keyguard-features/></uses-policies></device-admin>`.

- [ ] **Step 1: Failing tests.** `ExitPinTest`: set+verify ok; wrong 5 times → `LockedOut` 300 s; after lockout expiry another 5 wrong → 600 s; success resets counter; `set` rejects non-6-digit with `IllegalArgumentException`. `ModeControllerTest` (Robolectric): broadcast `ACTION_POWER_CONNECTED` → `DOCK`; `ACTION_POWER_DISCONNECTED` → `BATTERY`; `ACTION_SCREEN_OFF` → `screenOn=false`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): device owner kiosk manager, mode controller and exit PIN`

---

### Task 12: Wifi repository and captive portal

**Files:**
- Create: `app/src/main/kotlin/com/evenseal/usagedeck/wifi/WifiRepository.kt`, `CaptivePortalActivity.kt`
- Test: `app/src/test/kotlin/com/evenseal/usagedeck/wifi/WifiRepositoryTest.kt` (Robolectric `ShadowWifiManager`)

**Interfaces (Produces):**
```kotlin
data class WifiNetwork(val ssid: String, val rssi: Int, val security: Security, val saved: Boolean, val connected: Boolean) { enum class Security { OPEN, WPA, WPA3, EAP_UNSUPPORTED } }
data class WifiStatus(val connected: Boolean, val ssid: String?, val rssi: Int?, val ip: String?, val bars: Int /* 0..4 via WifiManager.calculateSignalLevel(rssi, 5) */)
class WifiRepository(private val context: Context, private val scope: CoroutineScope) {
    val status: StateFlow<WifiStatus>
    val scanResults: StateFlow<List<WifiNetwork>>        // updated from SCAN_RESULTS_AVAILABLE_ACTION; deduped by SSID keeping max RSSI; sorted RSSI desc
    val lastScanAt: StateFlow<Instant?>
    fun requestScan(): Boolean                           // rate-limited: at most once per 30 s in the UI; returns false if throttled
    fun connect(ssid: String, passphrase: String?): Result<Unit>   // Device Owner: WifiConfiguration + addNetwork + enableNetwork(disableOthers=true); OPEN → allowedKeyManagement NONE; WPA/WPA3 → preSharedKey quoted
    fun forget(ssid: String): Result<Unit>
    fun start(); fun stop()
}
class CaptivePortalActivity : ComponentActivity()          // WebView to http://connectivitycheck.gstatic.com/generate_204, toolbar with Done
```

- [ ] **Step 1: Failing Robolectric tests:** scan results dedupe by SSID keeping strongest; sort desc; `connect` on OPEN adds config with `allowedKeyManagement[NONE]`; `connect` on WPA quotes the passphrase; `requestScan` returns false within 30 s of the last; status reflects `ShadowWifiManager.connectionInfo`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): device-owner wifi repository and captive portal`

---

### Task 13: Pairing — payload, machine store, QR scanner

**Files:**
- Create: `app/src/main/kotlin/com/evenseal/usagedeck/pairing/PairingPayload.kt`, `MachineStore.kt`, `QrScanActivity.kt`
- Test: `app/src/test/kotlin/com/evenseal/usagedeck/pairing/PairingPayloadTest.kt`, `MachineStoreTest.kt`

**Interfaces (Produces):**
```kotlin
@Serializable data class PairingPayload(val v: Int, val name: String, val addr: String, val port: Int, val token: String) {
    fun toConfig(id: String = UUID.randomUUID().toString()) = MachineConfig(id, name, addr, port, token)
    companion object { fun parse(text: String): Result<PairingPayload> }   // fails on v != 1, blank token, invalid port, non-IPv4/hostname addr
}
class MachineStore(private val prefs: SharedPreferences /* EncryptedSharedPreferences "machines" */) {
    val machines: StateFlow<List<MachineConfig>>
    fun add(config: MachineConfig); fun remove(id: String); fun rename(id: String, name: String)
}
class QrScanActivity : ComponentActivity()   // zxing-android-embedded DecoratedBarcodeView; result extra "payload" = raw text; shows the live-credential warning text from spec §6.3 above the viewfinder
```
Also: `UsageDeckApp.installId` = UUID persisted in encrypted prefs on first run.

- [ ] **Step 1: Failing tests:** parse happy path; rejects `v:2`; rejects blank token; rejects port 0/70000; store add/remove round-trips through a real `EncryptedSharedPreferences` under Robolectric (fallback to plain in-memory `SharedPreferences` if Keystore is unavailable in Robolectric — wrap creation in `MachineStore.Companion.open(context)` that catches and uses `context.getSharedPreferences` in tests only via a constructor override).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): QR pairing payload and encrypted machine store`

---

### Task 14: Theme and shared components

**Files:**
- Create: `app/src/main/kotlin/com/evenseal/usagedeck/ui/theme/Color.kt`, `Type.kt`, `Theme.kt`
- Create: `app/src/main/res/font/` — download Barlow Condensed (500/600/700), IBM Plex Sans (400/500/600), IBM Plex Mono (400/500) TTFs from Google Fonts into `res/font/` with names `barlow_condensed_600.ttf` etc. and `font-family` XMLs
- Create: `ui/components/StatusBar.kt`, `LimitBar.kt`, `Sparkline.kt`, `PauseButton.kt`, `SessionRow.kt`, `BottomBar.kt`, `Format.kt`
- Test: `app/src/test/kotlin/com/evenseal/usagedeck/ui/components/FormatTest.kt`; `app/src/androidTest/kotlin/com/evenseal/usagedeck/ui/components/PauseButtonTest.kt`

**Interfaces (Produces):**
```kotlin
object DeckColors { val bg = Color(0xFF0E1013); val surface = Color(0xFF161A20); val surface2 = Color(0xFF1E242C); val line = Color(0xFF262D37); val fg = Color(0xFFE8EBEF); val muted = Color(0xFF8B95A3); val dim = Color(0xFF5C6674); val ok = Color(0xFF3DBE8B); val warn = Color(0xFFF0B429); val crit = Color(0xFFE5484D); val frozen = Color(0xFF5AB4C4); val accent = Color(0xFF8C9BFF) }
object DeckType { val numeral: FontFamily /* Barlow Condensed */; val text: FontFamily /* IBM Plex Sans */; val mono: FontFamily /* IBM Plex Mono */ }
@Composable fun DeckTheme(dimLevel: Float = 1f, content: @Composable () -> Unit)   // dimLevel multiplies alpha of a full-screen black scrim: 1f none, 0.35f night
object Format {
    fun tokens(n: Long): String            // 0 → "0", 999 → "999", 4200 → "4.2k", 1_200_000 → "1.2M", 12_400_000 → "12.4M"
    fun ratePerMin(r: Double): String      // "38k/min", "0/min", "412/min"
    fun resets(at: Instant?, now: Instant, zone: ZoneId): String  // null → "resets: unknown"; < 24 h → "resets 16:35 · 2h33"; else "resets Thu 09:00"
    fun countdown(until: Instant, now: Instant): String            // "0:42", "12:05"; past → "0:00"
    fun shortId(sessionId: String) = sessionId.take(4) + "…"
    fun age(since: Instant?, now: Instant): String                  // "4s ago", "3m ago", "2h ago", null → "never"
}
@Composable fun StatusBar(wifi: WifiStatus, machines: List<MachineState>, clock: Instant, alertChip: String?, onWifi: () -> Unit, onMachine: (String) -> Unit)
@Composable fun LimitBar(label: String, limit: Limit?, now: Instant)          // "5h" / "7d" + bar + percent + reset caption; null → "—"
@Composable fun Sparkline(series: List<Double>, modifier: Modifier, color: Color = DeckColors.accent)   // Canvas: area + line + endpoint dot
sealed interface PauseVisual { object Idle : PauseVisual; data class Soft(val countdown: String?) : PauseVisual; data class Frozen(val elapsed: String) : PauseVisual; object Disabled : PauseVisual; object InFlight : PauseVisual }
@Composable fun PauseButton(visual: PauseVisual, size: Dp = 34.dp, onTap: () -> Unit, onHold: () -> Unit)   // detectTapGestures(onTap, onLongPress) with 600 ms; haptic on hold; red ring only while holding
@Composable fun SessionRow(session: Session, rate: Double, series: List<Double>, machineName: String?, visual: PauseVisual, now: Instant, onTap: () -> Unit, onHold: () -> Unit, onOpen: () -> Unit)
@Composable fun BottomBar(primary: String, primaryDanger: Boolean, onPrimary: () -> Unit, onPrimaryHold: (() -> Unit)?, secondary: List<Pair<String, () -> Unit>>)
```

- [ ] **Step 1: Failing `FormatTest`** with the exact examples above. **Step 2: Fail. Step 3: Implement theme, fonts, components, `Format`.** **Step 4: PASS.** Then `PauseButtonTest` (androidTest): `performTouchInput { longClick(durationMillis = 700) }` triggers `onHold` not `onTap`; `performClick` triggers `onTap`; `Disabled` visual triggers neither.
- [ ] **Step 5: Commit** `feat(app): theme, fonts and shared dashboard components`

---

### Task 15: `DeckService` — foreground service wiring core into the app

**Files:**
- Create: `app/src/main/kotlin/com/evenseal/usagedeck/service/DeckService.kt`, `DeckGraph.kt`, `pause/PrefsEscalationStore.kt`, `alerts/Notifier.kt`, `settings/Settings.kt`
- Modify: `UsageDeckApp.kt`, `AndroidManifest.xml`
- Test: `app/src/test/kotlin/com/evenseal/usagedeck/pause/PrefsEscalationStoreTest.kt`, `settings/SettingsTest.kt`, `alerts/NotifierTest.kt`

**Interfaces:**
- Consumes (Track A): `MachineClient`, `OkHttpDaemonApi`, `DaemonEventSource`, `BurnHistory`, `TeamState`, `PauseController`, `AlertEvaluator`, `ReleaseChecker`, `Version`.
- Produces:
```kotlin
data class Settings(val warn: Int = 80, val critical: Int = 95, val escalationSeconds: Int? = 90, val quietStart: LocalTime = LocalTime.of(23, 0), val quietEnd: LocalTime = LocalTime.of(7, 0), val nightDim: Float = 0.35f, val pinSet: Boolean = false)
class SettingsStore(prefs: SharedPreferences) { val settings: StateFlow<Settings>; fun update(f: (Settings) -> Settings); fun isQuiet(now: LocalTime): Boolean }
class PrefsEscalationStore(prefs: SharedPreferences) : EscalationStore   // JSON list under key "escalations"
class Notifier(context: Context) {
    val overlay: StateFlow<Alert?>                       // dock-mode full-screen overlay, auto-clears after 8 s
    fun raise(alert: Alert, mode: DeckMode, quiet: Boolean)   // channel per kind; vibration patterns: WARN [0,80], CRITICAL [0,80,80,80,80,80], FROZEN [0,400], UNREACHABLE [0,80,120,80]; quiet → no vibration
}
class DeckGraph(app: Application) {                      // manual DI, singleton on Application
    val clock: Clock; val installId: String; val machineStore: MachineStore; val settings: SettingsStore
    val wifi: WifiRepository; val mode: ModeController; val kiosk: KioskManager; val exitPin: ExitPin
    val burn: BurnHistory; val clients: StateFlow<Map<String, MachineClient>>; val team: StateFlow<TeamState>
    val pause: PauseController; val notifier: Notifier; val updater: Updater
}
class DeckService : LifecycleService()   // START_STICKY; notification "Usage Deck running"; on create: start clients for each stored machine (react to machineStore changes), team = combine(clients.state) → TeamState, alert loop (evaluate prev→next, CRITICAL repeat every 10 min while still critical), pause.start(), updater loop
```
Alert loop: `team.scan(null to state)`, for each `Alert` call `notifier.raise(alert, mode.value, settings.isQuiet(now))`; keep `lastCriticalAt: Map<key, Instant>` to re-raise CRITICAL every 10 min while the user's limit is still `≥ critical`.

- [ ] **Step 1: Failing tests:** `PrefsEscalationStore` round-trip; `SettingsStore` defaults + update + `isQuiet` across midnight (23:30 quiet, 06:59 quiet, 07:00 not, 12:00 not); `Notifier` picks the vibration pattern per kind and skips vibration when quiet (Robolectric `ShadowVibrator`), and `overlay` clears after 8 s (`runTest` + `advanceTimeBy`).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): foreground DeckService wiring clients, pause, alerts and settings`

---

### Task 16: Ledger, Wide dock and navigation

**Files:**
- Create: `ui/ledger/LedgerScreen.kt`, `ui/widedock/WideDockScreen.kt`, `ui/DeckNav.kt`, `ui/DeckViewModel.kt`
- Modify: `MainActivity.kt`
- Test: `app/src/androidTest/kotlin/com/evenseal/usagedeck/ui/LedgerScreenTest.kt`, `WideDockScreenTest.kt`

**Interfaces:**
- Consumes: `TeamState`, `UserView`, `ProjectView`, `PauseController`, `BurnHistory`, `Format`, components from Task 14.
- Produces:
```kotlin
class DeckViewModel(graph: DeckGraph) : ViewModel() {
    val team: StateFlow<TeamState>; val now: StateFlow<Instant> /* 1 s ticker */; val wifi: StateFlow<WifiStatus>; val mode: StateFlow<DeckMode>
    val alertChip: StateFlow<String?>                     // latest WARN/CRITICAL body for 60 s
    fun rate(machineId: String, sessionId: String): Double; fun series(machineId: String, sessionId: String, minutes: Int = 30, buckets: Int = 16): List<Double>
    fun projectSeries(machineId: String, key: String): List<Double>   // 5 h, 30 buckets
    fun visual(target: PauseTarget): PauseVisual
    fun tap(target: PauseTarget); fun hold(target: PauseTarget)      // launch in viewModelScope
}
sealed interface Route { object Home : Route; data class Project(val machineId: String, val key: String) : Route; object Projects : Route; data class Machine(val id: String) : Route; object Wifi : Route; object Settings : Route; object Pairing : Route }
@Composable fun LedgerScreen(vm: DeckViewModel, onOpen: (Route) -> Unit)
@Composable fun WideDockScreen(vm: DeckViewModel, onOpen: (Route) -> Unit)
@Composable fun DeckNav(graph: DeckGraph)   // NavHost; Home renders Ledger in portrait, WideDock in landscape via LocalConfiguration.orientation
```
Ledger layout (spec §11.1): `StatusBar`; for each `UserView` a block (name, email or "last seen …", two `LimitBar`s, scoped chips) at 55 % alpha when its health is STALE/DEAD; header row "Sessions · N live · tokens/min · 30m"; `LazyColumn` of projects → header row (name, worktree tag, `PauseButton` for the project) then `SessionRow`s; `BottomBar("Pause all", danger=false, onPrimary = tap(All), onPrimaryHold = hold(All), secondary = [Projects, Wifi])`. Wide dock (§11.2): `Row { rail(200.dp) { users' big numbers 64 sp / 30 sp + captions + team footer }; Column { sessions LazyColumn; BottomBar } }`; alert chip in the status bar.

- [ ] **Step 1: Failing Compose tests** with a `DeckViewModel` built on a fake `DeckGraph` (fixture `TeamState` from Task 2 fixtures): Ledger shows both users' 5h percentages; a session with SOFT pause shows the countdown text; a DEAD machine's session rows have their pause button `assertIsNotEnabled`; tapping a session's pause calls `tap(Session(...))` (verify via a recording fake `PauseController` seam — make `DeckViewModel` take a `PauseActions` interface with `tap/hold` that the real graph implements). Wide dock: renders in `Configuration.ORIENTATION_LANDSCAPE` with the 64 sp numeral having text "42".
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): Ledger and Wide dock home screens with orientation switch`

---

### Task 17: Project drill-in and Projects list

**Files:**
- Create: `ui/project/ProjectScreen.kt`, `ui/project/BurnChart.kt`, `ui/projects/ProjectsScreen.kt`
- Test: `app/src/androidTest/kotlin/com/evenseal/usagedeck/ui/ProjectScreenTest.kt`

**Interfaces:** Consumes `ProjectView`, `DeckViewModel.projectSeries`, `Format`. Produces `@Composable fun ProjectScreen(vm: DeckViewModel, machineId: String, key: String, onBack: () -> Unit)`, `@Composable fun BurnChart(series: List<Double>, modifier: Modifier)` (Canvas: 3 gridlines, area, line, endpoint dot, y labels "0" and max rounded to 1 significant figure with `k` suffix, x labels "−2h30"/"now"), `@Composable fun ProjectsScreen(vm, onOpen)`.

Tiles (spec §11.3): today = `Format.tokens(project.todayTokens?.total ?: project.liveTokens.total)`; rate = `Format.ratePerMin(sum of session rates)`; share of today = `project today ÷ machine today` as `"61%"` or `"—"` when the denominator is 0. Sessions list rows: `shortId · since HH:mm · last tool <name> <age>` (or `last activity <age>` when `lastTool == null`) · countdown when soft-paused by this phone. Bottom: `BottomBar("Soft pause all N", danger=false, onPrimary = tap(Project), onPrimaryHold = hold(Project), secondary = [])` plus a separate red "Hold · freeze" hold-only button.

- [ ] **Step 1: Failing tests:** tiles render "1.9M", "38k/min", "61%" from a fixture where machine today = 3.1M-ish and project = 1.9M (choose numbers that divide to 61 %); denominator 0 renders "—"; a session without `lastTool` shows "last activity"; `BurnChart` draws without crashing on empty series.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): project drill-in with tiles, burn chart and projects list`

---

### Task 18: Machine detail, Wifi, Pairing, Settings, alert overlay, PIN gate

**Files:**
- Create: `ui/machine/MachineScreen.kt`, `ui/wifi/WifiScreen.kt`, `ui/pairing/PairingScreen.kt`, `ui/settings/SettingsScreen.kt`, `ui/alerts/AlertOverlay.kt`, `ui/kiosk/ExitGate.kt`
- Modify: `ui/DeckNav.kt`, `MainActivity.kt`
- Test: `app/src/androidTest/kotlin/com/evenseal/usagedeck/ui/WifiScreenTest.kt`, `SettingsScreenTest.kt`

Behaviour: Machine screen shows name, user, version, `update.state` (+ "waiting on frozen session" when `deferred`), last heartbeat age, transport (SSE/polling), Unpair with confirm. Wifi screen per spec §6.1 with "scanned Ns ago", rescan button disabled while throttled, tap network → passphrase sheet (skip for OPEN) → `connect`; saved list with Forget; "Open captive portal" button. Pairing screen: warning copy, "Scan QR" → `QrScanActivity` → `PairingPayload.parse` → `machineStore.add` → immediate `/health` probe → toast result. Settings: thresholds sliders (warn 50–94, critical warn+1–99), escalation (off/30/60/90/120/300/600 s), quiet hours pickers, night dim, set/change PIN, "Check for update now", version footer `BuildConfig.VERSION_NAME`. `ExitGate`: an invisible 48 dp box top-left; `detectTapGestures(onLongPress)` after 3 s hold → PIN dialog → `kiosk.stopLockTask` + `AlarmManager.setExact(+10 min)` → `LockTaskReceiver` → `startLockTask`. `AlertOverlay`: full-screen scrim with kind colour, title, body, auto-dismiss 8 s, shown only when `mode == DOCK`.

- [ ] **Step 1: Failing tests:** Wifi list sorted by RSSI and shows security tag; rescan disabled within 30 s; Settings critical slider can't go below warn+1; escalation "off" writes `null`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): machine, wifi, pairing, settings screens, alert overlay and exit gate`

---

### Task 19: Self-update — `Updater` and `ApkInstaller`

**Files:**
- Create: `app/src/main/kotlin/com/evenseal/usagedeck/update/Updater.kt`, `ApkInstaller.kt`, `InstallResultReceiver.kt`
- Modify: `AndroidManifest.xml` (receiver), `DeckGraph.kt`
- Test: `app/src/test/kotlin/com/evenseal/usagedeck/update/UpdaterTest.kt`

**Interfaces:**
- Consumes: `ReleaseChecker`, `Version`, `Sha256`, `PauseController.pending`, `PauseController.inFlight`.
- Produces:
```kotlin
sealed interface UpdaterState { object Idle : UpdaterState; object Checking : UpdaterState; data class Downloading(val version: Version) : UpdaterState; data class Deferred(val version: Version, val reason: String) : UpdaterState; data class Installing(val version: Version) : UpdaterState; data class Failed(val message: String) : UpdaterState }
class Updater(private val checker: ReleaseChecker, private val installed: Version, private val installer: ApkInstaller, private val cacheDir: File, private val client: OkHttpClient, private val deferWhile: () -> String? /* null = ok, else reason */, private val clock: Clock, private val scope: CoroutineScope, private val intervalMs: Long = 600_000) {
    val state: StateFlow<UpdaterState>
    fun start()                       // jittered ±10 % loop
    suspend fun checkNow()            // latest → newer? → download apk + sums to cacheDir → verify → deferWhile()? → installer.install(file)
}
class ApkInstaller(private val context: Context) { suspend fun install(apk: File): Result<Unit> }   // PackageInstaller session, MODE_FULL_INSTALL, setInstallReason(INSTALL_REASON_DEVICE_SETUP) is not available → use default; commit with PendingIntent to InstallResultReceiver; Device Owner → no user prompt
```
Deferral reasons: `"gesture"` when `pause.inFlight` non-empty; `"escalation_pending"` when `pause.pending` non-empty; re-check every 30 s while deferred. Keep the last downloaded APK as `cacheDir/last-update.apk` for `adb install -r` recovery; delete older ones.

- [ ] **Step 1: Failing tests** with MockWebServer for GitHub + assets and a recording fake installer: newer version downloads, verifies and installs; sha mismatch → `Failed` and file deleted; same version → stays `Idle`; `deferWhile` returning "escalation_pending" → `Deferred` then installs after it returns null on the next 30 s tick; network failure → `Failed`, next tick retries.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(app): self-update from GitHub releases with sha256 verify and deferral`

---

### Task 20: Integration, CI, docs

**Files:**
- Create: `.github/workflows/ci.yml`, `docs/device-setup.md`, `docs/teammate-onboarding.md`, `docs/smoke-test.md`, `README.md`, `CLAUDE.md`, `LICENSE`
- Create: `scripts/emulator.sh` (creates/starts an API 29 arm64 AVD `deck29` at 1080×1920), `scripts/fakedaemon.sh` (`./gradlew :fakedaemon:run --args="--port 47291 --scenario $1"`)
- Test: `app/src/androidTest/kotlin/com/evenseal/usagedeck/EndToEndTest.kt`

- [ ] **Step 1: End-to-end test** — starts `FakeDaemon` in-process on port 0 with `Scenarios.freeze`, seeds `MachineStore` with `MachineConfig("m", "fake", "10.0.2.2" or "127.0.0.1", port, "fake-token")`, launches `MainActivity`, waits for the Ledger to show "calendarpa", taps a session pause → asserts the fake's rules contain `session:<id>` with reason prefix `usage-deck:`; advances scenario to freeze → asserts the row shows "frozen".
- [ ] **Step 2: Run on the emulator** — `scripts/emulator.sh && ./gradlew :app:connectedDebugAndroidTest`. Expected: all androidTests pass.
- [ ] **Step 3: `ci.yml`**

```yaml
name: ci
on: { push: { branches: [main] }, pull_request: {} }
permissions: { contents: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - uses: android-actions/setup-android@v3
      - uses: gradle/actions/setup-gradle@v4
      - run: ./gradlew ktlintCheck :core:test :fakedaemon:test :app:testDebugUnitTest
      - name: Instrumented tests (API 29)
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 29
          arch: x86_64
          target: default
          script: ./gradlew :app:connectedDebugAndroidTest
      - name: Decode keystore
        if: github.ref == 'refs/heads/main'
        run: echo "$SIGNING_KEYSTORE_B64" | base64 -d > /tmp/release.jks
        env: { SIGNING_KEYSTORE_B64: ${{ secrets.SIGNING_KEYSTORE_B64 }} }
      - name: Assemble release
        if: github.ref == 'refs/heads/main'
        run: ./gradlew :app:assembleRelease
        env:
          SIGNING_KEYSTORE_PATH: /tmp/release.jks
          SIGNING_STORE_PASSWORD: ${{ secrets.SIGNING_STORE_PASSWORD }}
          SIGNING_KEY_ALIAS: ${{ secrets.SIGNING_KEY_ALIAS }}
          SIGNING_KEY_PASSWORD: ${{ secrets.SIGNING_KEY_PASSWORD }}
      - name: Version
        if: github.ref == 'refs/heads/main'
        id: v
        run: echo "version=0.1.$(git rev-list --count HEAD)+$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
      - name: Package
        if: github.ref == 'refs/heads/main'
        run: |
          cp app/build/outputs/apk/release/app-release.apk "usage-deck-${{ steps.v.outputs.version }}.apk"
          sha256sum "usage-deck-${{ steps.v.outputs.version }}.apk" > SHA256SUMS
      - name: Release
        if: github.ref == 'refs/heads/main'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.v.outputs.version }}
          files: |
            usage-deck-${{ steps.v.outputs.version }}.apk
            SHA256SUMS
```
- [ ] **Step 4: Docs.** `device-setup.md` = spec §4 steps 1–6 expanded into commands (`fastboot flashing unlock`, LineageOS 17.1 bullhead download URL placeholder replaced with the actual lineageos.org archive URL for `lineage-17.1-*-nightly-bullhead-signed.zip`, `adb sideload`, `adb install`, `dpm set-device-owner`, Tailscale APK from `pkgs.tailscale.com/stable/#android` or F-Droid, one-tap Doze exemption, "never set a screen lock", "Tailscale not as exit node", verify `curl -H "Authorization: Bearer …" http://100.x:47291/health` from the Mac). `teammate-onboarding.md` = install Tailscale + `claude-usage install` with `bind: tailscale` + `claude-usage configure pairing` → show the QR to the phone. `smoke-test.md` = spec §14 manual checklist. `README.md` = what it is, screenshots placeholder paths, build/run/emulator/fakedaemon commands, release flow. `CLAUDE.md` (< 6,000 chars): env exports, module map, test commands, the Global Constraints list verbatim, "never push", lefthook note.
- [ ] **Step 5: Generate the release keystore locally** — `keytool -genkeypair -v -keystore /tmp/usage-deck-release.jks -alias usagedeck -keyalg RSA -keysize 4096 -validity 10000` with passwords generated by `openssl rand -base64 24`; store keystore (base64) and passwords in 1Password vault `usagedeck`, item `usagedeck-ci`, fields `SIGNING_KEYSTORE_B64`, `SIGNING_KEY_ALIAS`, `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_PASSWORD` via the desktop app (never as command args); delete `/tmp/usage-deck-release.jks`. Document in README that GitHub secrets are populated from that item. **This step is done by the human, not an implementer** — the plan stops at writing the instructions into `docs/device-setup.md` § "Release signing".
- [ ] **Step 6: Commit** `ci: GitHub Actions release pipeline, docs and end-to-end test`

---

## Self-review notes

- Spec coverage: §4 → T11/T20; §5 → T11/T15/T16; §6.1 → T12/T18; §6.2 → T6 (health) + T18 (Tailscale row); §6.3 → T13/T18; §7 → T3/T4/T6; §8 → T1/T7; §9 → T8/T14/T16; §10 → T9/T15; §11 → T14/T16/T17/T18; §12 → T9/T19; §13 → T20; §14 → every task's tests + T10 + T20; §15 → file structure above.
- Type consistency: `PauseTarget.scope()` string format matches daemon `scope` values; `MachineState.rev` feeds `If-None-Match: W/"<rev>"`; `PauseVisual.Soft(countdown)` is fed by `PauseController.escalationFor(target)` + `Format.countdown`.
- Known human step: release keystore creation and GitHub secrets (T20 step 5).
