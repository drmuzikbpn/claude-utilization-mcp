package com.evenseal.usagedeck.core.daemon

import java.io.IOException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PinnedTlsTest {
    private val server = MockWebServer()

    @After
    fun down() {
        runCatching { server.shutdown() }
    }

    private fun get(client: OkHttpClient): String =
        client.newCall(Request.Builder().url(server.url("/health")).build()).execute().use { it.body!!.string() }

    @Test
    fun `fingerprint is the SHA-256 of the SubjectPublicKeyInfo, matching the daemon's fixture`() {
        val der = javaClass.getResourceAsStream("/fixtures/tls/cert.der")!!.use { it.readBytes() }
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream()) as X509Certificate
        val expected = Fixtures.text("tls/fingerprint.txt").trim()

        assertEquals(expected, PinnedTls.fingerprint(cert))
    }

    @Test
    fun `accepts the pinned self-signed certificate whatever host name it was dialled by`() {
        val held = serveHttps(commonName = "not-this-host")
        server.enqueue(MockResponse().setBody("ok"))

        val client = PinnedTls.client(OkHttpClient(), PinnedTls.fingerprint(held.certificate))

        assertEquals("ok", get(client))
    }

    @Test
    fun `refuses any other certificate and reports it as a pin mismatch`() {
        serveHttps()
        server.enqueue(MockResponse().setBody("ok"))
        val other = PinnedTls.fingerprint(HeldCertificate.Builder().ecdsa256().build().certificate)

        val error = assertThrows(IOException::class.java) { get(PinnedTls.client(OkHttpClient(), other)) }

        assertTrue(PinnedTls.isPinMismatch(error))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `a malformed pin never matches`() {
        serveHttps()
        server.enqueue(MockResponse().setBody("ok"))

        val error = assertThrows(IOException::class.java) { get(PinnedTls.client(OkHttpClient(), "")) }
        assertTrue(PinnedTls.isPinMismatch(error))
    }

    @Test
    fun `an unreachable host is not a pin mismatch`() {
        server.start()
        val url = server.url("/")
        server.shutdown()
        val client = PinnedTls.client(OkHttpClient(), "0".repeat(64))

        val error = assertThrows(IOException::class.java) {
            client.newCall(Request.Builder().url(url.newBuilder().scheme("https").build()).build()).execute()
        }
        assertFalse(PinnedTls.isPinMismatch(error))
    }

    private fun serveHttps(commonName: String = "claude-usage"): HeldCertificate {
        val held = HeldCertificate.Builder().commonName(commonName).ecdsa256().build()
        val certs = HandshakeCertificates.Builder().heldCertificate(held).build()
        server.useHttps(certs.sslSocketFactory(), false)
        server.start()
        return held
    }
}
