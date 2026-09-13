package com.evenseal.usagedeck.kiosk

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class ModeControllerTest {
    private lateinit var context: Context
    private lateinit var controller: ModeController

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        controller = ModeController(context)
        controller.start()
    }

    @After
    fun tearDown() {
        controller.stop()
    }

    private fun broadcast(action: String) {
        context.sendBroadcast(Intent(action))
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun `starts in battery mode when not plugged in`() {
        assertEquals(DeckMode.BATTERY, controller.mode.value)
    }

    @Test
    fun `power connected switches to dock mode`() {
        broadcast(Intent.ACTION_POWER_CONNECTED)
        assertEquals(DeckMode.DOCK, controller.mode.value)
    }

    @Test
    fun `power disconnected switches to battery mode`() {
        broadcast(Intent.ACTION_POWER_CONNECTED)
        broadcast(Intent.ACTION_POWER_DISCONNECTED)
        assertEquals(DeckMode.BATTERY, controller.mode.value)
    }

    @Test
    fun `screen off clears screenOn and screen on restores it`() {
        assertTrue(controller.screenOn.value)
        broadcast(Intent.ACTION_SCREEN_OFF)
        assertFalse(controller.screenOn.value)
        broadcast(Intent.ACTION_SCREEN_ON)
        assertTrue(controller.screenOn.value)
    }

    @Test
    fun `stop unregisters the receiver so later broadcasts are ignored`() {
        controller.stop()
        broadcast(Intent.ACTION_POWER_CONNECTED)
        assertEquals(DeckMode.BATTERY, controller.mode.value)
    }
}
