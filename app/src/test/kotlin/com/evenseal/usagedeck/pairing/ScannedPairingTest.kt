package com.evenseal.usagedeck.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScannedPairingTest {
    private val fp = "eeeb5db71defbf5a8dcd133e886b617f68a2cdfb8853e0b46ac1da446bdc1a27"
    private val link = "usagedeck://pair?v=2&name=mbp&addrs=192.168.1.20%2C100.64.1.2&port=47292" +
        "&fp=$fp&code=AbCdEfGhIjKlMnOpQrSt_-"

    @Test
    fun `a v2 link needs redeeming`() {
        val scanned = ScannedPairing.parse(link).getOrThrow() as ScannedPairing.Invite
        assertEquals(listOf("192.168.1.20", "100.64.1.2"), scanned.invite.addrs)
    }

    @Test
    fun `v1 json is still a ready pairing`() {
        val text = """{"v":1,"name":"mbp","addr":"100.1.1.1","port":8787,"token":"t"}"""
        val scanned = ScannedPairing.parse(text).getOrThrow() as ScannedPairing.Legacy
        assertEquals("t", scanned.payload.token)
    }

    @Test
    fun `a malformed v2 link reports the link's own problem`() {
        val message = ScannedPairing.parse(link.replace(fp, "abc")).exceptionOrNull()!!.message!!
        assertTrue(message, message.contains("fingerprint"))
    }

    @Test
    fun `anything else is rejected`() {
        assertTrue(ScannedPairing.parse("hello").isFailure)
        assertTrue(ScannedPairing.parse("https://example.com").isFailure)
    }
}
