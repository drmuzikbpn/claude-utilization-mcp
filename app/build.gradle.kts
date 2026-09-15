import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Runs git against the repository root with a clean environment. A Gradle daemon first started
 * from a git hook (lefthook) inherits GIT_DIR/GIT_INDEX_FILE and would stamp every later build
 * with "not a git repository"; dropping GIT_* makes the stamp independent of who started the daemon.
 */
fun git(vararg cmd: String): String = runCatching {
    val process = ProcessBuilder("git", *cmd)
        .directory(rootProject.projectDir)
        .apply { environment().keys.removeAll { it.startsWith("GIT_") } }
        .start()
    val out = process.inputStream.bufferedReader().readText().trim()
    if (process.waitFor() == 0) out else ""
}.getOrDefault("")

val commitCount = git("rev-list", "--count", "HEAD").toIntOrNull() ?: 1
val shortSha = git("rev-parse", "--short", "HEAD").ifBlank { "dev" }

android {
    namespace = "com.evenseal.usagedeck"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.evenseal.usagedeck"
        minSdk = 29
        targetSdk = 29
        versionCode = commitCount
        versionName = "0.1.$commitCount+$shortSha"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField(
            "String",
            "RELEASE_REPO",
            "\"${System.getenv("RELEASE_REPO") ?: "drmuzikbpn/claude-utilization-mcp"}\""
        )
    }
    // Release APKs leave Gradle unsigned: CI signs them with apksigner and app/signing/usage-deck.lineage
    // (a rotation from this Mac's debug key), so the phone provisioned with a debug build updates in place.
    buildTypes {
        release { isMinifyEnabled = false }
    }
    lint {
        // Not a Play Store app: the kiosk targets API 29 on purpose (Nexus 5X, LineageOS 17.1).
        disable += "ExpiredTargetSdkVersion"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
}

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

dependencies {
    implementation(project(":core"))
    val bom = platform(libs.compose.bom)
    implementation(bom)
    androidTestImplementation(bom)
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.tooling.preview)
    implementation(libs.navigation.compose)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.service)
    implementation(libs.coroutines.android)
    implementation(libs.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.security.crypto)
    implementation(libs.zxing.embedded)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.ext)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(project(":fakedaemon"))
    androidTestImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(libs.androidx.test.ext)
    androidTestImplementation(libs.espresso.core)
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
