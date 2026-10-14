// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.pairing

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ReplaceConfirmDialogTest {
    @get:Rule
    val compose = createComposeRule()

    private fun show(onChoice: (String) -> Unit) = compose.setContent {
        ReplaceConfirmDialog(
            oldName = "studio",
            newName = "adams-mbp",
            onReplace = { onChoice("replace") },
            onKeepBoth = { onChoice("both") },
            onCancel = { onChoice("cancel") }
        )
    }

    @Test
    fun `asks before replacing one machine with another`() {
        var choice: String? = null
        show { choice = it }

        compose.onNodeWithText("Replace studio with adams-mbp?").assertExists()
        compose.onNodeWithText("Replace").performClick()

        assertEquals("replace", choice)
    }

    @Test
    fun `keep both pairs the scanned machine separately`() {
        var choice: String? = null
        show { choice = it }

        compose.onNodeWithText("Keep both").performClick()

        assertEquals("both", choice)
    }

    @Test
    fun `a sideloaded file names both machines and can only be accepted or refused`() {
        var choice: String? = null
        compose.setContent {
            ImportConfirmDialog(
                oldName = "studio",
                newName = "impostor",
                onReplace = { choice = "replace" },
                onCancel = { choice = "cancel" }
            )
        }

        compose.onNodeWithText("Replace studio with impostor?").assertExists()
        compose.onNodeWithText("Keep both").assertDoesNotExist()
        compose.onNodeWithText("Cancel").performClick()

        assertEquals("cancel", choice)
    }

    @Test
    fun `a scan that would overwrite a machine paired with another certificate says so`() {
        compose.setContent {
            ReplaceConfirmDialog(
                oldName = "studio",
                newName = "impostor",
                onReplace = {},
                onKeepBoth = {},
                onCancel = {},
                reRepairing = false
            )
        }

        compose.onNodeWithText("different certificate", substring = true).assertExists()
    }
}
