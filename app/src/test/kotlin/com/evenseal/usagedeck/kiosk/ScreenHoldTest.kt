package com.evenseal.usagedeck.kiosk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenHoldTest {
    @Test
    fun `docked always holds the screen, whatever the toggle says`() {
        assertTrue(ScreenHold.shouldHold(DeckMode.DOCK, keepScreenOn = true))
        assertTrue(ScreenHold.shouldHold(DeckMode.DOCK, keepScreenOn = false))
    }

    @Test
    fun `on battery the toggle decides`() {
        assertTrue(ScreenHold.shouldHold(DeckMode.BATTERY, keepScreenOn = true))
        assertFalse(ScreenHold.shouldHold(DeckMode.BATTERY, keepScreenOn = false))
    }
}
