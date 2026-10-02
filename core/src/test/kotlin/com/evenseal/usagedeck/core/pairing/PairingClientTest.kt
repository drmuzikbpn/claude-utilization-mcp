package com.evenseal.usagedeck.core.pairing

import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.daemon.PinnedTls
import java.net.InetAddress
import java.net.UnknownHostException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PairingClientTest {
    private val server = MockWebServer()
    private val held = HeldCertificate.Builder().commonName("claude-usage").ecdsa256().build()
    private val fp = PinnedTls.fingerprint(held.certificate)
    private val code = "AbCdEfGhIjKlMnOpQrSt_-"

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

    private fun invite(addrs: List<String> = listOf("dead.test", "live.test"), fp: String = this.fp) =
        PairingInvite("Alan's MBP", addrs, server.port, fp, code)

    private fun ok(name: String? = "alans-mbp", fp: String? = this.fp, token: String = "the-bearer") = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(
            buildString {
                append("""{"token":"$token"""")
                if (name != null) append(""","name":"$name"""")
                append(""","fp":${fp?.let { "\"$it\"" } ?: "null"}}""")
            }
        )

    private fun error(status: Int, code: String, message: String, hint: String) = MockResponse()
        .setResponseCode(status)
        .setBody("""{"error":{"code":"$code","message":"$message","hint":"$hint"}}""")

    private fun redeemFails(invite: PairingInvite = invite()): DaemonException = assertThrows(
        DaemonException::class.java
    ) {
        runBlocking { PairingClient(client).redeem(invite, "id-1") }
    }

    @Test
    fun `redeems the code over pinned https without a bearer and returns a pinned machine`() = runTest {
        server.enqueue(ok())

        val machine = PairingClient(client).redeem(invite(), "id-1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/pair", request.path)
        assertNull(request.getHeader("Authorization"))
        assertEquals("""{"code":"$code"}""", request.body.readUtf8())

        assertEquals("id-1", machine.id)
        assertEquals("alans-mbp", machine.name)
        assertEquals("live.test", machine.addr)
        assertEquals(server.port, machine.port)
        assertEquals("the-bearer", machine.token)
        assertEquals(fp, machine.fp)
        assertEquals(listOf("dead.test", "live.test"), machine.addrs)
        assertTrue(machine.baseUrl.startsWith("https://"))
    }

    @Test
    fun `tries addresses in the link's order and stops at the first that answers`() = runTest {
        server.enqueue(ok())

        PairingClient(client).redeem(invite(listOf("dead.test", "live.test", "dead2.test")), "id-1")

        assertEquals(listOf("dead.test", "live.test"), lookups)
    }

    @Test
    fun `keeps the link's name when the daemon sends none`() = runTest {
        server.enqueue(ok(name = null, fp = null))
        assertEquals("Alan's MBP", PairingClient(client).redeem(invite(), "id-1").name)
    }

    @Test
    fun `an invalid or expired code is unauthorized with the daemon's hint and is not retried elsewhere`() {
        server.enqueue(
            error(401, "unauthorized", "pairing code is invalid or expired", "run `claude-usage pair` again")
        )

        val e = redeemFails(invite(listOf("live.test", "live2.test")))

        assertEquals("unauthorized", e.code)
        assertEquals("run `claude-usage pair` again", e.userMessage())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `too many attempts is rate limited`() {
        server.enqueue(
            error(
                429,
                "rate_limited",
                "too many failed pairing attempts",
                "wait a minute, then run `claude-usage pair` again"
            )
        )
        val e = redeemFails()
        assertEquals("rate_limited", e.code)
        assertEquals("wait a minute, then run `claude-usage pair` again", e.userMessage())
    }

    @Test
    fun `a bare 429 still reads as rate limited`() {
        server.enqueue(MockResponse().setResponseCode(429))
        val e = redeemFails()
        assertEquals("rate_limited", e.code)
        assertTrue(e.userMessage().contains("Too many attempts"))
    }

    @Test
    fun `a reply naming another key is refused`() {
        server.enqueue(ok(fp = "b".repeat(64)))
        assertEquals("pinning", redeemFails().code)
    }

    @Test
    fun `a reply without a token is refused`() {
        server.enqueue(ok(token = ""))
        assertEquals("bad_response", redeemFails().code)
    }

    @Test
    fun `a server presenting another certificate is never sent the code`() {
        server.enqueue(ok())
        val e = redeemFails(invite(listOf("live.test"), fp = "c".repeat(64)))
        assertEquals("pinning", e.code)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `no reachable address is a network error`() {
        val e = redeemFails(invite(listOf("dead.test", "dead2.test")))
        assertEquals("network", e.code)
    }

    @Test
    fun `the redeemed machine never prints its token`() = runTest {
        server.enqueue(ok())
        val machine = PairingClient(client).redeem(invite(), "id-1")
        assertFalse(machine.toString().contains("the-bearer"))
    }

    @Test
    fun `a code that reached a daemon whose reply was lost is never sent to another address`() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(ok())

        val e = redeemFails(invite(listOf("live.test", "live2.test")))

        assertEquals("reply_lost", e.code)
        assertTrue(e.userMessage().contains("claude-usage pair"))
        assertEquals(1, server.requestCount)
        assertFalse("live2.test" in lookups)
    }

    @Test
    fun `a reply cut off mid-body is reported as lost, not retried`() {
        server.enqueue(ok().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        server.enqueue(ok())

        val e = redeemFails(invite(listOf("live.test", "live2.test")))

        assertEquals("reply_lost", e.code)
        assertEquals(1, server.requestCount)
    }
}
