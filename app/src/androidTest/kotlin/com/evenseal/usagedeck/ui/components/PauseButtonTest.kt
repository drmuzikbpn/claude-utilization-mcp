package com.evenseal.usagedeck.ui.components

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.ui.theme.DeckTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PauseButtonTest {
    @get:Rule
    val compose = createComposeRule()

    private var taps = 0
    private var holds = 0

    private fun show(visual: PauseVisual) {
        compose.setContent {
            DeckTheme {
                PauseButton(
                    visual = visual,
                    onTap = { taps++ },
                    onHold = { holds++ }
                )
            }
        }
    }

    private fun node() = compose.onNodeWithContentDescription(PauseButtonDefaults.CONTENT_DESCRIPTION)

    @Test
    fun tapTriggersOnTapOnly() {
        show(PauseVisual.Idle)

        node().performClick()

        assertEquals(1, taps)
        assertEquals(0, holds)
    }

    @Test
    fun holdPastSixHundredMillisTriggersOnHoldOnly() {
        show(PauseVisual.Idle)

        node().performTouchInput { longClick(durationMillis = 700) }

        assertEquals(1, holds)
        assertEquals(0, taps)
    }

    @Test
    fun disabledVisualTriggersNeitherCallback() {
        show(PauseVisual.Disabled)

        node().performClick()
        node().performTouchInput { longClick(durationMillis = 700) }

        assertEquals(0, taps)
        assertEquals(0, holds)
    }

    @Test
    fun inFlightVisualTriggersNeitherCallback() {
        show(PauseVisual.InFlight)

        node().performClick()
        node().performTouchInput { longClick(durationMillis = 700) }

        assertEquals(0, taps)
        assertEquals(0, holds)
    }

    @Test
    fun aPausedControlStillAcceptsATapToResume() {
        show(PauseVisual.Soft(countdown = "0:42"))

        node().performClick()

        assertEquals(1, taps)
        assertEquals(0, holds)
    }
}
