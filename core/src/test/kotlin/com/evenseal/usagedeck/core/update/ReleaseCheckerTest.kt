package com.evenseal.usagedeck.core.update

import java.io.File
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ReleaseCheckerTest {
    private val server = MockWebServer()
    private lateinit var checker: ReleaseChecker

    @Before
    fun up() {
        server.start()
        checker = ReleaseChecker(
            repo = "drmuzikbpn/android-project",
            client = OkHttpClient(),
            baseUrl = server.url("/").toString().trimEnd('/')
        )
    }

    @After
    fun down() {
        runCatching { server.shutdown() }
    }

    private fun releaseJson(sumsUrl: String, apkUrl: String) = """
        { "tag_name":"v0.1.418+abc",
          "assets":[
            {"name":"usage-deck-0.1.418+abc.apk","browser_download_url":"$apkUrl"},
            {"name":"SHA256SUMS","browser_download_url":"$sumsUrl"}
          ] }
    """.trimIndent()

    @Test
    fun `latest parses the tag and both assets`() = runTest {
        val apkUrl = server.url("/assets/usage-deck-0.1.418+abc.apk").toString()
        val sumsUrl = server.url("/assets/SHA256SUMS").toString()
        server.enqueue(MockResponse().setBody(releaseJson(sumsUrl, apkUrl)))

        val info = checker.latest()!!
        assertEquals(Version(0, 1, 418, "abc"), info.version)
        assertEquals("usage-deck-0.1.418+abc.apk", info.apkName)
        assertEquals(apkUrl, info.apkUrl)
        assertEquals(sumsUrl, info.sumsUrl)
        assertEquals("/repos/drmuzikbpn/android-project/releases/latest", server.takeRequest().path)
    }

    @Test
    fun `a release with no matching apk asset yields null`() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"tag_name":"v0.1.418+abc","assets":[{"name":"SHA256SUMS","browser_download_url":"x"}]}"""
            )
        )
        assertNull(checker.latest())
    }

    @Test
    fun `an unparseable tag yields null`() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"tag_name":"nightly","assets":[{"name":"usage-deck-x.apk","browser_download_url":"x"},""" +
                    """{"name":"SHA256SUMS","browser_download_url":"y"}]}"""
            )
        )
        assertNull(checker.latest())
    }

    @Test
    fun `a 404 from github yields null`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        assertNull(checker.latest())
    }

    @Test
    fun `expectedSha256 finds the line for this apk`() = runTest {
        val apkUrl = server.url("/assets/usage-deck-0.1.418+abc.apk").toString()
        val sumsUrl = server.url("/assets/SHA256SUMS").toString()
        server.enqueue(MockResponse().setBody(releaseJson(sumsUrl, apkUrl)))
        val info = checker.latest()!!
        server.takeRequest()

        val hex = "a".repeat(64)
        server.enqueue(
            MockResponse().setBody("${"b".repeat(64)}  other.apk\n$hex  usage-deck-0.1.418+abc.apk\n")
        )
        assertEquals(hex, checker.expectedSha256(info))
        assertEquals("/assets/SHA256SUMS", server.takeRequest().path)
    }

    @Test
    fun `expectedSha256 is null when the apk is not listed`() = runTest {
        val apkUrl = server.url("/assets/usage-deck-0.1.418+abc.apk").toString()
        val sumsUrl = server.url("/assets/SHA256SUMS").toString()
        server.enqueue(MockResponse().setBody(releaseJson(sumsUrl, apkUrl)))
        val info = checker.latest()!!
        server.takeRequest()

        server.enqueue(MockResponse().setBody("${"b".repeat(64)}  something-else.apk\n"))
        assertNull(checker.expectedSha256(info))
    }

    @Test
    fun `isNewer compares by build`() {
        assertTrue(checker.isNewer(Version(0, 1, 418, "abc"), Version(0, 1, 417, "zzz")))
        assertFalse(checker.isNewer(Version(0, 1, 417, "abc"), Version(0, 1, 417, "zzz")))
        assertFalse(checker.isNewer(Version(0, 1, 416, "abc"), Version(0, 1, 417, "zzz")))
    }
}

class Sha256Test {
    @Test
    fun `hex of the empty input is the known digest`() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Sha256.hex(ByteArray(0)))
    }

    @Test
    fun `hex of abc is the known digest`() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            Sha256.hex("abc".toByteArray())
        )
    }

    @Test
    fun `hexOf reads a file in chunks`() {
        val file = File.createTempFile("usage-deck", ".bin")
        file.deleteOnExit()
        file.writeBytes("abc".toByteArray())
        assertEquals(Sha256.hex("abc".toByteArray()), Sha256.hexOf(file))
    }
}
