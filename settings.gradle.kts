// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "usage-deck"
include(":core", ":fakedaemon", ":app")
