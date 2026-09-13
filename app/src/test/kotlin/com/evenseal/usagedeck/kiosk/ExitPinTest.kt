package com.evenseal.usagedeck.kiosk

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.FakeClock
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ExitPinTest {
    private lateinit var prefs: SharedPreferences
    private lateinit var clock: FakeClock
    private lateinit var pin: ExitPin

    private val t0: Instant = Instant.parse("2026-09-13T10:00:00Z")

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences("exit_pin_test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        clock = FakeClock(t0)
        pin = ExitPin(prefs, clock)
    }

    @Test
    fun `set then verify returns Ok`() {
        assertFalse(pin.isSet())
        pin.set("123456")
        assertTrue(pin.isSet())
        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))
    }

    @Test
    fun `set rejects a pin that is not six digits`() {
        listOf("", "12345", "1234567", "12345a", "abcdef", " 12345").forEach { bad ->
            var threw = false
            try {
                pin.set(bad)
            } catch (e: IllegalArgumentException) {
                threw = true
            }
            assertTrue("expected IllegalArgumentException for '$bad'", threw)
        }
    }

    @Test
    fun `five wrong attempts lock out for 300 seconds`() {
        pin.set("123456")
        assertEquals(ExitPin.Result.Wrong(4), pin.verify("000000"))
        assertEquals(ExitPin.Result.Wrong(3), pin.verify("000000"))
        assertEquals(ExitPin.Result.Wrong(2), pin.verify("000000"))
        assertEquals(ExitPin.Result.Wrong(1), pin.verify("000000"))
        assertEquals(ExitPin.Result.LockedOut(t0.plusSeconds(300)), pin.verify("000000"))
    }

    @Test
    fun `verify during lockout returns LockedOut without consuming an attempt`() {
        pin.set("123456")
        repeat(5) { pin.verify("000000") }
        clock.advance(60)
        assertEquals(ExitPin.Result.LockedOut(t0.plusSeconds(300)), pin.verify("123456"))
    }

    @Test
    fun `lockout doubles on the next round`() {
        pin.set("123456")
        repeat(5) { pin.verify("000000") }
        clock.advance(300)
        assertEquals(ExitPin.Result.Wrong(4), pin.verify("000000"))
        assertEquals(ExitPin.Result.Wrong(3), pin.verify("000000"))
        assertEquals(ExitPin.Result.Wrong(2), pin.verify("000000"))
        assertEquals(ExitPin.Result.Wrong(1), pin.verify("000000"))
        assertEquals(
            ExitPin.Result.LockedOut(t0.plusSeconds(300 + 600)),
            pin.verify("000000")
        )
    }

    @Test
    fun `a correct pin resets the failure counter`() {
        pin.set("123456")
        repeat(4) { pin.verify("000000") }
        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))
        assertEquals(ExitPin.Result.Wrong(4), pin.verify("000000"))
    }

    @Test
    fun `state survives a new instance over the same prefs`() {
        pin.set("123456")
        val reopened = ExitPin(prefs, clock)
        assertTrue(reopened.isSet())
        assertEquals(ExitPin.Result.Ok, reopened.verify("123456"))
    }
}
