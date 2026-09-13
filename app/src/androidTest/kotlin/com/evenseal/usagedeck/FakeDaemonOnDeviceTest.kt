package com.evenseal.usagedeck

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.fakedaemon.FakeDaemon
import com.evenseal.usagedeck.fakedaemon.Scenarios
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Proves the Ktor `fakedaemon` module really serves from inside an Android process, so a manual
 * run on the emulator can point the deck at it instead of a Mac.
 *
 * Scope is deliberately REST only. As of 2026-09-13 the same server's `/v1/events` stream
 * truncates the large `snapshot` frame on-device — the client gets `event: snapshot` and then the
 * connection closes before `data:` — which is why [EndToEndTest] scripts its own stream. When
 * that is fixed, the SSE half belongs here and `EndToEndTest` can use the real fake again.
 */
@RunWith(AndroidJUnit4::class)
class FakeDaemonOnDeviceTest {
    private lateinit var daemon: FakeDaemon

    private val client = OkHttpClient.Builder()
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    @Before
    fun setUp() {
        daemon = FakeDaemon(port = PORT, token = TOKEN, scenario = Scenarios.idle)
        daemon.start()
    }

    @After
    fun tearDown() {
        daemon.stop()
    }

    private fun get(path: String) = Request.Builder()
        .url("http://127.0.0.1:$PORT$path")
        .header("Authorization", "Bearer $TOKEN")
        .get()
        .build()

    @Test
    fun servesRestFromInsideTheAppProcess() {
        client.newCall(get("/health")).execute().use { response ->
            val body = response.body?.string().orEmpty()
            assertTrue("status ${response.code} body '$body'", response.isSuccessful)
            assertTrue("body was '$body'", body.contains("\"ok\""))
        }
    }

    @Test
    fun servesTheSessionsEndpointItsScenariosBuildOn() {
        client.newCall(get("/v1/sessions")).execute().use { response ->
            val body = response.body?.string().orEmpty()
            assertTrue("status ${response.code} body '$body'", response.isSuccessful)
            assertTrue("body was '$body'", body.contains("\"sessionId\""))
        }
    }

    /** The fake deliberately lets loopback GETs through unauthenticated so `curl` stays easy. */
    @Test
    fun allowsAnUnauthenticatedLoopbackGet() {
        val request = Request.Builder().url("http://127.0.0.1:$PORT/health").get().build()
        client.newCall(request).execute().use { response ->
            assertTrue("status was ${response.code}", response.isSuccessful)
        }
    }

    /** Writes are guarded whatever the origin. */
    @Test
    fun rejectsAWrongTokenOnAWrite() {
        val request = Request.Builder()
            .url("http://127.0.0.1:$PORT/v1/pause")
            .header("Authorization", "Bearer nope")
            .post("""{"scope":"all","mode":"soft"}""".toRequestBody(JSON))
            .build()
        client.newCall(request).execute().use { response ->
            assertTrue("status was ${response.code}", response.code == 401)
        }
    }

    private companion object {
        const val PORT = 47298
        const val TOKEN = "fake-token"
        val JSON = "application/json".toMediaType()
    }
}
