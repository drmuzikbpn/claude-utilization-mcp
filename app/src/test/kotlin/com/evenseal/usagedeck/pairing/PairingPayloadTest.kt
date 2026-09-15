package com.evenseal.usagedeck.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadTest {
    private val happy =
        """{"v":1,"name":"macbook-pro-10","addr":"100.101.102.103","port":8787,"token":"tok-abc"}"""

    @Test
    fun `parses the payload claude-usage configure pairing prints`() {
        val payload = PairingPayload.parse(happy).getOrThrow()
        assertEquals(1, payload.v)
        assertEquals("macbook-pro-10", payload.name)
        assertEquals("100.101.102.103", payload.addr)
        assertEquals(8787, payload.port)
        assertEquals("tok-abc", payload.token)
    }

    @Test
    fun `accepts a tailnet hostname as the address`() {
        val text = """{"v":1,"name":"mbp","addr":"macbook-pro-10.tail0fake.ts.net","port":8787,"token":"t"}"""
        assertEquals(
            "macbook-pro-10.tail0fake.ts.net",
            PairingPayload.parse(text).getOrThrow().addr
        )
    }

    @Test
    fun `rejects a future payload version`() {
        val text = """{"v":2,"name":"mbp","addr":"100.1.1.1","port":8787,"token":"t"}"""
        assertTrue(PairingPayload.parse(text).isFailure)
    }

    @Test
    fun `rejects a blank token`() {
        val text = """{"v":1,"name":"mbp","addr":"100.1.1.1","port":8787,"token":"   "}"""
        assertTrue(PairingPayload.parse(text).isFailure)
    }

    @Test
    fun `rejects an out of range port`() {
        listOf(0, -1, 70000, 65536).forEach { port ->
            val text = """{"v":1,"name":"mbp","addr":"100.1.1.1","port":$port,"token":"t"}"""
            assertTrue("port $port should be rejected", PairingPayload.parse(text).isFailure)
        }
    }

    @Test
    fun `accepts the port range boundaries`() {
        listOf(1, 65535).forEach { port ->
            val text = """{"v":1,"name":"mbp","addr":"100.1.1.1","port":$port,"token":"t"}"""
            assertEquals(port, PairingPayload.parse(text).getOrThrow().port)
        }
    }

    @Test
    fun `rejects an address that is neither IPv4 nor a hostname`() {
        listOf("", "   ", "100.1.1", "300.1.1.1", "100.1.1.1.1", "not a host", "http://1.2.3.4")
            .forEach { addr ->
                val text = """{"v":1,"name":"mbp","addr":"$addr","port":8787,"token":"t"}"""
                assertTrue("addr '$addr' should be rejected", PairingPayload.parse(text).isFailure)
            }
    }

    @Test
    fun `rejects text that is not the pairing JSON at all`() {
        listOf("", "not json", "{}", """{"v":1}""", "https://example.com").forEach { text ->
            assertTrue("'$text' should be rejected", PairingPayload.parse(text).isFailure)
        }
    }

    @Test
    fun `ignores unknown fields so the daemon can add some`() {
        val text =
            """{"v":1,"name":"mbp","addr":"100.1.1.1","port":8787,"token":"t","issuedAt":"2026-09-13"}"""
        assertEquals("mbp", PairingPayload.parse(text).getOrThrow().name)
    }

    @Test
    fun `toConfig carries every field and the supplied id`() {
        val config = PairingPayload.parse(happy).getOrThrow().toConfig("machine-1")
        assertEquals("machine-1", config.id)
        assertEquals("macbook-pro-10", config.name)
        assertEquals("100.101.102.103", config.addr)
        assertEquals(8787, config.port)
        assertEquals("tok-abc", config.token)
        assertEquals("http://100.101.102.103:8787", config.baseUrl)
    }

    @Test
    fun `toConfig mints a unique id when none is given`() {
        val payload = PairingPayload.parse(happy).getOrThrow()
        assertTrue(payload.toConfig().id != payload.toConfig().id)
    }
}
