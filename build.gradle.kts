// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
    alias(libs.plugins.ktlint) apply false
}

/**
 * Every Kotlin source and build script opens with the project's licence header. `ktlintCheck`
 * depends on this, so the pre-commit hook and CI both fail on a file that lacks it.
 */
val licenseHeaders = tasks.register("licenseHeaders") {
    group = "verification"
    description = "Fails when a Kotlin file does not start with the SPDX licence header."
    val sources = fileTree(rootDir) {
        include("**/*.kt", "**/*.kts")
        exclude("**/build/**", ".gradle/**", "**/.gradle/**")
    }
    inputs.files(sources)
    val root = rootDir
    doLast {
        val expected = listOf(
            "// SPDX-License-Identifier: MIT",
            "// Copyright (c) 2026 Even Seal Productions"
        )
        val missing = sources.files
            .filter { file -> file.useLines { it.take(expected.size).toList() } != expected }
            .map { it.relativeTo(root).path }
            .sorted()
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Missing licence header (${expected.joinToString(" / ")}) in:\n  " + missing.joinToString("\n  ")
            )
        }
    }
}

subprojects {
    apply(plugin = "org.jlleitschuh.gradle.ktlint")
    // The engine the code is formatted to. Plugin 14 defaults to a newer ktlint with new rules;
    // adopting those is a reformat of its own, not part of a build-tool upgrade.
    extensions.configure<org.jlleitschuh.gradle.ktlint.KtlintExtension> { version.set("1.0.1") }
    tasks.matching { it.name == "ktlintCheck" }.configureEach { dependsOn(licenseHeaders) }
}
