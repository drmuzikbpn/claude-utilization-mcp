package com.evenseal.usagedeck.core.daemon

import java.net.ConnectException
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class EndpointsTest {
    @Test
    fun `tries addresses in order and remembers the one that answered`() {
        val endpoints = Endpoints(listOf("a", "b", "c"))
        val tried = mutableListOf<String>()

        val answer = endpoints.first { addr ->
            tried += addr
            if (addr == "a") throw ConnectException("refused")
            "via $addr"
        }

        assertEquals("via b", answer)
        assertEquals(listOf("a", "b"), tried)
        assertEquals(listOf("b", "a", "c"), endpoints.ordered())
        assertEquals("b", endpoints.current())
    }

    @Test
    fun `an error from a daemon that answered is final`() {
        val endpoints = Endpoints(listOf("a", "b"))
        val tried = mutableListOf<String>()

        val e = assertThrows(DaemonException::class.java) {
            endpoints.first<String> { addr ->
                tried += addr
                throw DaemonException("unauthorized", 401, null, null)
            }
        }

        assertEquals("unauthorized", e.code)
        assertEquals(listOf("a"), tried)
    }

    @Test
    fun `every address down is a network error`() {
        val e = assertThrows(DaemonException::class.java) {
            Endpoints(listOf("a", "b")).first<String> { throw UnknownHostException(it) }
        }
        assertEquals("network", e.code)
    }

    @Test
    fun `every address presenting the wrong key is a pinning error`() {
        val e = assertThrows(DaemonException::class.java) {
            Endpoints(listOf("a", "b")).first<String> {
                throw javax.net.ssl.SSLHandshakeException("bad cert").apply { initCause(PinMismatchException()) }
            }
        }
        assertEquals("pinning", e.code)
    }

    @Test
    fun `a mix of wrong keys and dead addresses is a network error`() {
        val e = assertThrows(DaemonException::class.java) {
            Endpoints(listOf("a", "b")).first<String> { addr ->
                if (addr == "a") {
                    throw javax.net.ssl.SSLHandshakeException("bad cert").apply { initCause(PinMismatchException()) }
                }
                throw ConnectException("refused")
            }
        }
        assertEquals("network", e.code)
    }

    @Test
    fun `retryable decides which transport failures move on`() {
        val endpoints = Endpoints(listOf("a", "b"))
        val tried = mutableListOf<String>()

        assertThrows(DaemonException::class.java) {
            endpoints.first<String>(retryable = { it is ConnectException }) { addr ->
                tried += addr
                throw java.net.SocketTimeoutException("timeout")
            }
        }
        assertEquals(listOf("a"), tried)
    }

    @Test
    fun `failed rotates the preferred address so the next connection tries another`() {
        val endpoints = Endpoints(listOf("a", "b", "c"))
        assertEquals("a", endpoints.current())

        endpoints.failed("a")
        assertEquals("b", endpoints.current())
        endpoints.failed("b")
        assertEquals("c", endpoints.current())
        endpoints.failed("c")
        assertEquals("a", endpoints.current())

        endpoints.failed("b") // not the current one: a stale report changes nothing
        assertEquals("a", endpoints.current())
    }
}
