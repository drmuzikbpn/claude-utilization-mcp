package com.evenseal.usagedeck.core.model

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TypesTest {
    @Test
    fun `tokens total sums the four counters not messages`() {
        val t = Tokens(input = 1, output = 2, cacheCreate = 3, cacheRead = 4, messages = 99)
        assertEquals(10L, t.total)
    }

    @Test
    fun `tokens plus adds fieldwise`() {
        assertEquals(Tokens(2, 4, 6, 8, 10), Tokens(1, 2, 3, 4, 5) + Tokens(1, 2, 3, 4, 5))
    }

    @Test
    fun `session canHardPause requires hook discovery and pid`() {
        val base =
            Session(
                "s", 1, true, Discovered.HOOK, "/x", null, "k", "x", null, null,
                Instant.EPOCH, Instant.EPOCH, Tokens.ZERO, null, null
            )
        assertTrue(base.canHardPause)
        assertFalse(base.copy(pid = null).canHardPause)
        assertFalse(base.copy(discovered = Discovered.TRANSCRIPT).canHardPause)
    }

    @Test
    fun `machine config builds http base url`() {
        assertEquals("http://100.68.1.2:47291", MachineConfig("m", "n", "100.68.1.2", 47291, "t").baseUrl)
    }
}
