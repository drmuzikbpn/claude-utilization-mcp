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
            newName = "alans-mbp",
            onReplace = { onChoice("replace") },
            onKeepBoth = { onChoice("both") },
            onCancel = { onChoice("cancel") }
        )
    }

    @Test
    fun `asks before replacing one machine with another`() {
        var choice: String? = null
        show { choice = it }

        compose.onNodeWithText("Replace studio with alans-mbp?").assertExists()
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
}
