// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.settings

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.evenseal.usagedeck.settings.Settings
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Once one machine is paired the home screen offers Projects, not Pair: another Mac is added here. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class PairFromSettingsTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `settings opens pairing for another machine`() {
        var opened = false
        compose.setContent {
            SettingsScreen(
                settings = Settings(),
                version = "0.1.1+test",
                updateState = "up to date",
                onUpdate = {},
                onSetPin = { _, _ -> null },
                onCheckUpdate = {},
                onBack = {},
                onPair = { opened = true }
            )
        }

        compose.onNodeWithText("Pair a machine").performClick()

        assertTrue(opened)
    }
}
