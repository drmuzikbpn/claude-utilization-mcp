package com.evenseal.usagedeck.core.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingInviteTest {
    private val fp = "eeeb5db71defbf5a8dcd133e886b617f68a2cdfb8853e0b46ac1da446bdc1a27"
    private val code = "AbCdEfGhIjKlMnOpQrSt_-"

    /** Exactly what the daemon's `buildPairingLink` emits: `encodeURIComponent` on name, addrs, fp, code. */
    private fun link(
        v: String? = "2",
        name: String? = "Alan%E2%80%99s%20MacBook",
        addrs: String? = "192.168.1.20%2Calans-mbp.local%2C100.64.1.2",
        port: String? = "47292",
        fp: String? = this.fp,
        code: String? = this.code
    ): String {
        val parts = listOfNotNull(
            v?.let { "v=$it" },
            name?.let { "name=$it" },
            addrs?.let { "addrs=$it" },
            port?.let { "port=$it" },
            fp?.let { "fp=$it" },
            code?.let { "code=$it" }
        )
        return "usagedeck://pair?" + parts.joinToString("&")
    }

    private fun parse(text: String) = PairingInvite.parse(text)

    private fun failure(text: String): String = parse(text).exceptionOrNull()!!.message!!

    @Test
    fun `parses the daemon's link`() {
        val invite = parse(link()).getOrThrow()
        assertEquals("Alan’s MacBook", invite.name)
        assertEquals(listOf("192.168.1.20", "alans-mbp.local", "100.64.1.2"), invite.addrs)
        assertEquals(47292, invite.port)
        assertEquals(fp, invite.fp)
        assertEquals(code, invite.code)
    }

    @Test
    fun `tolerates surrounding whitespace, an upper-case scheme and fingerprint, and literal commas`() {
        val text = "  USAGEDECK://pair?v=2&name=mbp&addrs=192.168.1.20,100.64.1.2&port=47292" +
            "&fp=${fp.uppercase()}&code=$code\n"
        val invite = parse(text).getOrThrow()
        assertEquals(listOf("192.168.1.20", "100.64.1.2"), invite.addrs)
        assertEquals(fp, invite.fp)
    }

    @Test
    fun `drops empty and duplicate addresses but keeps the daemon's order`() {
        val invite = parse(link(addrs = "100.64.1.2%2C%2C192.168.1.20%2C100.64.1.2")).getOrThrow()
        assertEquals(listOf("100.64.1.2", "192.168.1.20"), invite.addrs)
    }

    @Test
    fun `rejects a link that is not a pairing link`() {
        assertTrue(parse("https://example.com/pair?v=2").isFailure)
        assertTrue(parse("usagedeck://other?v=2").isFailure)
        assertTrue(parse("not a link at all").isFailure)
    }

    @Test
    fun `rejects an unknown or missing version`() {
        assertTrue(failure(link(v = "3")).contains("update Usage Deck"))
        assertTrue(parse(link(v = "1")).isFailure)
        assertTrue(parse(link(v = null)).isFailure)
        assertTrue(parse(link(v = "two")).isFailure)
    }

    @Test
    fun `rejects missing fields`() {
        assertTrue(parse(link(name = null)).isFailure)
        assertTrue(parse(link(name = "%20")).isFailure)
        assertTrue(parse(link(addrs = null)).isFailure)
        assertTrue(parse(link(addrs = "")).isFailure)
        assertTrue(parse(link(port = null)).isFailure)
        assertTrue(parse(link(fp = null)).isFailure)
        assertTrue(parse(link(code = null)).isFailure)
    }

    @Test
    fun `rejects a bad port`() {
        listOf("0", "65536", "-1", "x", "").forEach {
            assertTrue("port '$it' should be rejected", parse(link(port = it)).isFailure)
        }
        assertEquals(65535, parse(link(port = "65535")).getOrThrow().port)
    }

    @Test
    fun `rejects a fingerprint that is not 64 hex digits`() {
        assertTrue(parse(link(fp = fp.dropLast(1))).isFailure)
        assertTrue(parse(link(fp = fp + "0")).isFailure)
        assertTrue(parse(link(fp = fp.dropLast(1) + "g")).isFailure)
        assertTrue(failure(link(fp = "abc")).contains("fingerprint"))
    }

    @Test
    fun `rejects a code that is short or not base64url`() {
        assertTrue(parse(link(code = code.drop(1))).isFailure)
        assertTrue(parse(link(code = code.dropLast(1) + "%2B")).isFailure)
        assertTrue(parse(link(code = code.dropLast(1) + "%2F")).isFailure)
        assertTrue(failure(link(code = "")).contains("code"))
    }

    @Test
    fun `rejects an invalid address`() {
        listOf("100.1.1", "999.1.1.1", "-bad-.local", "a%20b").forEach {
            assertTrue("addr '$it' should be rejected", parse(link(addrs = "192.168.1.20%2C$it")).isFailure)
        }
    }

    @Test
    fun `never prints the code`() {
        val invite = parse(link()).getOrThrow()
        assertFalse(invite.toString().contains(code))
        assertTrue(invite.toString().contains("alans-mbp.local"))
    }

    @Test
    fun `isLink recognises only the v2 scheme`() {
        assertTrue(PairingInvite.isLink(link()))
        assertTrue(PairingInvite.isLink("  usagedeck://pair?v=9"))
        assertFalse(PairingInvite.isLink("""{"v":1}"""))
    }
}
