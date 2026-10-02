package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.PauseMode
import java.net.InetAddress
import java.net.UnknownHostException
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A v2-paired machine: REST and SSE over HTTPS pinned to the daemon's key, across its addresses. */
class PinnedTransportTest {
    private val server = MockWebServer()
    private val held = HeldCertificate.Builder().commonName("claude-usage").ecdsa256().build()
    private val fp = PinnedTls.fingerprint(held.certificate)

    /** `live*.test` resolve to the mock daemon; anything else does not resolve at all. */
    private val lookups = mutableListOf<String>()
    private val client = OkHttpClient.Builder()
        .dns(
            object : Dns {
                override fun lookup(hostname: String): List<InetAddress> {
                    lookups += hostname
                    if (hostname.startsWith("live")) return listOf(InetAddress.getByName(server.hostName))
                    throw UnknownHostException(hostname)
                }
            }
        )
        .build()

    @Before
    fun up() {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(held).build().sslSocketFactory(), false)
        server.start()
    }

    @After
    fun down() {
        runCatching { server.shutdown() }
    }

    private fun config(
        addr: String = "dead.test",
        addrs: List<String> = listOf(
            "dead.test",
            "live.test"
        ),
        fp: String = this.fp
    ) = MachineConfig("m", "n", addr, server.port, "tok", fp = fp, addrs = addrs)

    private fun health() = MockResponse().setBody(Fixtures.text("health.json"))

    @Test
    fun `rest goes over pinned https with the bearer`() = runTest {
        server.enqueue(health())

        OkHttpDaemonApi(config(addr = "live.test", addrs = listOf("live.test")), client).health()

        val request = server.takeRequest()
        assertEquals("Bearer tok", request.getHeader("Authorization"))
        assertTrue(request.requestUrl.toString().startsWith("https://"))
    }

    @Test
    fun `a dead address falls back to the next and is skipped afterwards`() = runTest {
        server.enqueue(health())
        server.enqueue(health())
        val api = OkHttpDaemonApi(config(), client)

        api.health()
        api.health()

        // The second call goes straight to live.test (its pooled connection, even): dead.test is not retried.
        assertEquals(1, lookups.count { it == "dead.test" })
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a pause also falls back when an address cannot be dialled`() = runTest {
        server.enqueue(MockResponse().setBody(Fixtures.text("pause-response.json")))

        OkHttpDaemonApi(config(), client).pause("all", PauseMode.SOFT, "usage-deck:x")

        assertEquals("/v1/pause", server.takeRequest().path)
    }

    @Test
    fun `a daemon presenting another key is a pinning error`() {
        server.enqueue(health())
        val api = OkHttpDaemonApi(config(addr = "live.test", addrs = listOf("live.test"), fp = "d".repeat(64)), client)

        val e = assertThrows(DaemonException::class.java) { runBlocking { api.health() } }

        assertEquals("pinning", e.code)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `sse goes over pinned https`() = runTest {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "text/event-stream").setBody("event: heartbeat\ndata: {}\n\n")
        )

        val items = DaemonEventSource(config(addr = "live.test", addrs = listOf("live.test")), client).events().toList()

        assertEquals(Connection.Open, items.first())
        assertTrue(server.takeRequest().requestUrl.toString().startsWith("https://"))
    }

    @Test
    fun `sse moves to the next address after a failed connect and remembers a good one for rest`() = runTest {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "text/event-stream").setBody("event: heartbeat\ndata: {}\n\n")
        )
        server.enqueue(health())
        val endpoints = Endpoints(config().candidates)
        val source = DaemonEventSource(config(), client, endpoints)

        val first = source.events().toList()
        val second = source.events().toList()
        OkHttpDaemonApi(config(), client, endpoints).health()

        assertEquals(listOf(Connection.Closed::class), first.map { it::class })
        assertEquals(Connection.Open, second.first())
        assertEquals("live.test", endpoints.current())
        assertEquals(1, lookups.count { it == "dead.test" })
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `sse against another key closes with a pinning error`() = runTest {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "text/event-stream").setBody("event: heartbeat\ndata: {}\n\n")
        )

        val items = DaemonEventSource(
            config(addr = "live.test", addrs = listOf("live.test"), fp = "e".repeat(64)),
            client
        ).events().toList()

        assertEquals("pinning", (items.single() as Connection.Closed).error!!.code)
    }
}
