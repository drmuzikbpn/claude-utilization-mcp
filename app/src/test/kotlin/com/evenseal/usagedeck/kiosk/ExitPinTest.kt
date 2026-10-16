// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.kiosk

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.FakeClock
import java.security.MessageDigest
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ExitPinTest {
    private class FakeUptime(var elapsed: Long = 1_000_000, var boot: Int = 7) : Uptime {
        override fun elapsedMillis(): Long = elapsed

        override fun bootCount(): Int = boot
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var clock: FakeClock
    private lateinit var uptime: FakeUptime
    private lateinit var pin: ExitPin

    private val t0: Instant = Instant.parse("2026-09-13T10:00:00Z")

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences("exit_pin_test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        clock = FakeClock(t0)
        uptime = FakeUptime()
        pin = ExitPin(prefs, clock, uptime)
    }

    /** Time passing for real: the wall clock and the monotonic one move together. */
    private fun pass(seconds: Long) {
        clock.advance(seconds)
        uptime.elapsed += seconds * 1000
    }

    private fun lockOut() = repeat(5) { pin.verify("000000") }

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
            assertThrows("for '$bad'", IllegalArgumentException::class.java) { pin.set(bad) }
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
        lockOut()
        pass(60)
        assertEquals(ExitPin.Result.LockedOut(t0.plusSeconds(300)), pin.verify("123456"))
    }

    @Test
    fun `lockout doubles on the next round`() {
        pin.set("123456")
        lockOut()
        pass(300)
        assertEquals(ExitPin.Result.Wrong(4), pin.verify("000000"))
        repeat(3) { pin.verify("000000") }
        assertEquals(ExitPin.Result.LockedOut(t0.plusSeconds(300 + 600)), pin.verify("000000"))
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
        val reopened = ExitPin(prefs, clock, uptime)
        assertTrue(reopened.isSet())
        assertEquals(ExitPin.Result.Ok, reopened.verify("123456"))
    }

    // ---- changing the PIN --------------------------------------------------------------------

    @Test
    fun `a pin that is already set cannot be set again without the current one`() {
        pin.set("123456")
        assertThrows(IllegalStateException::class.java) { pin.set("654321") }
        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))
    }

    @Test
    fun `change needs the current pin and then accepts only the new one`() {
        pin.set("123456")

        assertEquals(ExitPin.Result.Ok, pin.change("123456", "654321"))

        assertEquals(ExitPin.Result.Wrong(4), pin.verify("123456"))
        assertEquals(ExitPin.Result.Ok, pin.verify("654321"))
    }

    @Test
    fun `a wrong current pin changes nothing and counts as a failed attempt`() {
        pin.set("123456")

        assertEquals(ExitPin.Result.Wrong(4), pin.change("000000", "654321"))
        assertEquals(ExitPin.Result.Wrong(3), pin.verify("000000"))
        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))
    }

    @Test
    fun `guessing through change hits the same lockout, and a locked-out change is refused`() {
        pin.set("123456")
        repeat(4) { pin.change("000000", "654321") }

        assertEquals(ExitPin.Result.LockedOut(t0.plusSeconds(300)), pin.change("000000", "654321"))
        assertEquals(ExitPin.Result.LockedOut(t0.plusSeconds(300)), pin.change("123456", "654321"))

        pass(300)
        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))
    }

    @Test
    fun `change rejects a malformed new pin before spending an attempt`() {
        pin.set("123456")
        assertThrows(IllegalArgumentException::class.java) { pin.change("000000", "12") }
        assertEquals(ExitPin.Result.Wrong(4), pin.verify("000000"))
    }

    // ---- storage -----------------------------------------------------------------------------

    @Test
    fun `the pin is stored with pbkdf2, not a bare digest`() {
        pin.set("123456")
        assertEquals("pbkdf2-hmac-sha256", prefs.getString("exit_pin_kdf", null))
        assertTrue(prefs.getInt("exit_pin_iterations", 0) >= 100_000)
        assertFalse(
            prefs.getString("exit_pin_hash", "") == sha256Hash(prefs.getString("exit_pin_salt", "")!!, "123456")
        )
    }

    private fun sha256Hash(saltB64: String, pin: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(Base64.decode(saltB64, Base64.NO_WRAP))
        return Base64.encodeToString(digest.digest(pin.toByteArray()), Base64.NO_WRAP)
    }

    private fun storeLegacy(pin: String) {
        val salt = Base64.encodeToString(ByteArray(16) { it.toByte() }, Base64.NO_WRAP)
        prefs.edit().putString("exit_pin_salt", salt).putString("exit_pin_hash", sha256Hash(salt, pin)).commit()
    }

    @Test
    fun `a pin stored as salted sha-256 still verifies and is rehashed on that success`() {
        storeLegacy("123456")
        val before = prefs.getString("exit_pin_hash", null)

        assertTrue(pin.isSet())
        assertEquals(ExitPin.Result.Wrong(4), pin.verify("000000"))
        assertEquals(before, prefs.getString("exit_pin_hash", null))
        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))

        assertEquals("pbkdf2-hmac-sha256", prefs.getString("exit_pin_kdf", null))
        assertFalse(before == prefs.getString("exit_pin_hash", null))
        assertEquals(ExitPin.Result.Ok, ExitPin(prefs, clock, uptime).verify("123456"))
    }

    // ---- the lockout clock -------------------------------------------------------------------

    @Test
    fun `moving the wall clock forward does not end a lockout`() {
        pin.set("123456")
        lockOut()

        clock.advance(86_400)

        assertTrue(pin.verify("123456") is ExitPin.Result.LockedOut)
    }

    @Test
    fun `moving the wall clock back does not extend one`() {
        pin.set("123456")
        lockOut()
        uptime.elapsed += 300_000
        clock.advance(-86_400)

        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))
    }

    @Test
    fun `a reboot restarts the lockout in full rather than clearing it`() {
        pin.set("123456")
        lockOut()
        pass(200)

        uptime.boot += 1
        uptime.elapsed = 5_000

        assertEquals(ExitPin.Result.LockedOut(clock.now().plusSeconds(300)), pin.verify("123456"))
        pass(299)
        assertTrue(pin.verify("123456") is ExitPin.Result.LockedOut)
        pass(1)
        assertEquals(ExitPin.Result.Ok, pin.verify("123456"))
    }

    @Test
    fun `a lockout stored by the old wall-clock scheme is carried over, capped`() {
        pin.set("123456")
        prefs.edit().putLong("exit_pin_locked_until", t0.plusSeconds(10L * 365 * 86_400).toEpochMilli()).commit()

        val locked = pin.verify("123456") as ExitPin.Result.LockedOut

        assertEquals(t0.plusSeconds(300L shl 7), locked.until)
        assertFalse(prefs.contains("exit_pin_locked_until"))
    }

    @Test
    fun `clear with the right pin removes it`() {
        pin.set("123456")
        assertEquals(ExitPin.Result.Ok, pin.clear("123456"))
        assertFalse(pin.isSet())
        pin.set("654321")
        assertEquals(ExitPin.Result.Ok, pin.verify("654321"))
    }

    @Test
    fun `clear with a wrong pin keeps it and counts the attempt`() {
        pin.set("123456")
        assertEquals(ExitPin.Result.Wrong(4), pin.clear("000000"))
        assertTrue(pin.isSet())
        assertEquals(ExitPin.Result.Wrong(3), pin.verify("000000"))
    }

    @Test
    fun `clear is refused during a lockout`() {
        pin.set("123456")
        lockOut()
        assertTrue(pin.clear("123456") is ExitPin.Result.LockedOut)
        assertTrue(pin.isSet())
    }
}
