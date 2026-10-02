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

    @Test
    fun `a pinned machine config builds an https base url and lists its addresses, redeemed one first`() {
        val config = MachineConfig(
            "m",
            "n",
            "100.68.1.2",
            47292,
            "t",
            fp = "a".repeat(64),
            addrs = listOf("192.168.1.20", "mbp.local", "100.68.1.2")
        )
        assertEquals("https://100.68.1.2:47292", config.baseUrl)
        assertEquals("https://mbp.local:47292", config.baseUrlFor("mbp.local"))
        assertEquals(listOf("100.68.1.2", "192.168.1.20", "mbp.local"), config.candidates)
        assertEquals(listOf("100.68.1.2"), MachineConfig("m", "n", "100.68.1.2", 47291, "t").candidates)
    }

    @Test
    fun `machine config never prints its token`() {
        val config = MachineConfig("m", "n", "100.68.1.2", 47291, "secret-token")
        assertFalse(config.toString().contains("secret-token"))
    }
}
