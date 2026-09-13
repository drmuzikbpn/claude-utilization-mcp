package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.PauseMode
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DaemonApiTest {
    private val server = MockWebServer()
    private lateinit var api: DaemonApi

    @Before
    fun up() {
        server.start()
        api = OkHttpDaemonApi(MachineConfig("m", "n", server.hostName, server.port, "tok"), OkHttpClient())
    }

    @After
    fun down() {
        runCatching { server.shutdown() }
    }

    private fun fixture(n: String) = Fixtures.text(n)

    @Test
    fun `sends bearer token and parses sessions with etag`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("sessions.json")).addHeader("ETag", "W/\"812\""))
        val r = api.sessions(null) as SessionsResult.Changed
        assertEquals("W/\"812\"", r.etag)
        assertEquals(812L, r.dto.rev)
        assertEquals(3, r.dto.sessions.size)
        val req = server.takeRequest()
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals("/v1/sessions", req.path)
    }

    @Test
    fun `304 yields Unchanged and sends If-None-Match`() = runTest {
        server.enqueue(MockResponse().setResponseCode(304))
        assertEquals(SessionsResult.Unchanged, api.sessions("W/\"812\""))
        assertEquals("W/\"812\"", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test
    fun `401 envelope becomes DaemonException with hint`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(
                Fixtures.errorStatus("unauthorized")
            ).setBody(Fixtures.errorBody("unauthorized"))
        )
        val e = assertThrows(DaemonException::class.java) { runBlocking { api.summary() } }
        assertEquals("unauthorized", e.code)
        assertTrue(e.userMessage().startsWith("mutating requests need the token"))
    }

    @Test
    fun `non-json 500 falls back to code default`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))
        val e = assertThrows(DaemonException::class.java) { runBlocking { api.health() } }
        assertEquals("http_500", e.code)
        assertEquals("Daemon error (http_500)", e.userMessage())
    }

    @Test
    fun `pause posts json body to v1 pause`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("pause-response.json")))
        api.pause("all", PauseMode.SOFT, "usage-deck:abc")
        val req = server.takeRequest()
        assertEquals("/v1/pause", req.path)
        assertEquals("POST", req.method)
        assertEquals("""{"scope":"all","mode":"soft","reason":"usage-deck:abc"}""", req.body.readUtf8())
    }

    @Test
    fun `resume posts scope and rules parse`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("resume-response.json")))
        assertEquals(listOf("r_k3m7qz4ub2ah6ptc"), api.resume("all").removed)
        val req = server.takeRequest()
        assertEquals("/v1/resume", req.path)
        assertEquals("""{"scope":"all"}""", req.body.readUtf8())

        server.enqueue(MockResponse().setBody(fixture("pause-rules.json")))
        val rules = api.rules()
        assertEquals(814L, rules.rev)
        assertEquals(3, rules.rules.size)
        assertEquals(PauseMode.HARD, rules.rules.first().toModel().mode)
        assertEquals("/v1/pause/rules", server.takeRequest().path)
    }

    @Test
    fun `a hard pause on a session with no trusted pid is a 409 conflict`() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(Fixtures.errorStatus("untrusted_pid"))
                .setBody(Fixtures.errorBody("untrusted_pid"))
        )
        val e = assertThrows(DaemonException::class.java) {
            runBlocking { api.pause("session:c70bd853-62b1-4f42-8c14-2b7dcfe6578c", PauseMode.HARD, "usage-deck:t") }
        }
        assertEquals("conflict", e.code)
        assertEquals(409, e.httpStatus)
        assertTrue(e.userMessage().startsWith("hard freeze needs a session"))
    }

    @Test
    fun `a pause on a session that has exited is a 410 gone`() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(Fixtures.errorStatus("dead_session"))
                .setBody(Fixtures.errorBody("dead_session"))
        )
        val e = assertThrows(DaemonException::class.java) {
            runBlocking { api.pause("session:8ad4e017-5b22-4c90-9f3d-7e6b1a0c3350", PauseMode.SOFT, "usage-deck:t") }
        }
        assertEquals("gone", e.code)
        assertEquals(410, e.httpStatus)
        assertEquals("no rule was created", e.userMessage())
    }

    @Test
    fun `health parses name and update`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("health.json")))
        val h = api.health()
        assertEquals("alans-mbp", h.name)
        assertEquals("deferred", h.update!!.state)
        assertEquals("/health", server.takeRequest().path)
    }

    @Test
    fun `tokens uses groupBy project since today`() = runTest {
        server.enqueue(MockResponse().setBody(fixture("tokens-project.json")))
        api.tokensByProjectToday()
        assertEquals("/v1/tokens?since=today&groupBy=project", server.takeRequest().path)
    }

    @Test
    fun `connection refused is a network error`() = runTest {
        server.shutdown()
        val e = assertThrows(DaemonException::class.java) { runBlocking { api.health() } }
        assertEquals("network", e.code)
    }
}
