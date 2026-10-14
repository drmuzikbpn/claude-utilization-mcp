// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    application
}
kotlin { jvmToolchain(17) }
application { mainClass.set("com.evenseal.usagedeck.fakedaemon.MainKt") }
dependencies {
    implementation(project(":core"))
    implementation(libs.ktor.server.core)
    implementation(libs.ktor.server.cio)
    implementation(libs.ktor.server.content.negotiation)
    implementation(libs.ktor.serialization.json)
    implementation(libs.coroutines.core)
    // HeldCertificate: a self-signed certificate without the JDK-internal or BouncyCastle APIs.
    implementation(libs.okhttp.tls)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp)
    testImplementation(libs.okhttp.sse)
}
