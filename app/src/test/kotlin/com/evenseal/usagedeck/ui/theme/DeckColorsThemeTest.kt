// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.theme

import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class DeckColorsThemeTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `text fields in dialogs outside DeckNav draw the deck foreground`() {
        // A text field's typed text is colorScheme.onSurface. The default light scheme's is near
        // black, invisible on the deck's dark dialog surface: the first-PIN dialog looked dead.
        var onSurface = Color.Unspecified
        var content = Color.Unspecified
        compose.setContent {
            DeckColorsTheme {
                onSurface = MaterialTheme.colorScheme.onSurface
                content = LocalContentColor.current
            }
        }
        compose.waitForIdle()
        assertEquals(DeckColors.fg, onSurface)
        assertEquals(DeckColors.fg, content)
    }

    @Test
    fun `without it Material falls back to dark text`() {
        var onSurface = Color.Unspecified
        compose.setContent { onSurface = MaterialTheme.colorScheme.onSurface }
        compose.waitForIdle()
        assertNotEquals(DeckColors.fg, onSurface)
    }
}
