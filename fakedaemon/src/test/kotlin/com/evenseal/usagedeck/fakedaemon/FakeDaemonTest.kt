package com.evenseal.usagedeck.fakedaemon

import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class FakeDaemonTest {
    private val json = "application/json".toMediaType()
    private val client = OkHttpClient.Builder()
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()
    private var port = 0
    private lateinit var daemon: FakeDaemon

    @Before
    fun up() {
        port = ServerSocket(0).use { it.localPort }
        daemon = FakeDaemon(port = port)
        daemon.start()
    }

    @After
    fun down() {
        daemon.stop()
    }

    private fun url(path: String) = "http://127.0.0.1:$port$path"

    private fun get(path: String, etag: String? = null, token: String? = null): Response {
        val builder = Request.Builder().url(url(path)).get()
        etag?.let { builder.header("If-None-Match", it) }
        token?.let { builder.header("Authorization", "Bearer $it") }
        return client.newCall(builder.build()).execute()
    }

    private fun post(path: String, body: String, token: String? = daemon.token): Response {
        val builder = Request.Builder().url(url(path)).post(body.toRequestBody(json))
        token?.let { builder.header("Authorization", "Bearer $it") }
        return client.newCall(builder.build()).execute()
    }

    private fun delete(path: String, token: String? = daemon.token): Response {
        val builder = Request.Builder().url(url(path)).delete()
        token?.let { builder.header("Authorization", "Bearer $it") }
        return client.newCall(builder.build()).execute()
    }

    @Test
    fun `health reports name version user and update`() {
        get("/health").use { r ->
            assertEquals(200, r.code)
            val body = r.body!!.string()
            assertTrue(body.contains("\"name\":\"fake-mbp\""))
            assertTrue(body.contains("\"version\""))
            assertTrue(body.contains("\"user\""))
            assertTrue(body.contains("\"update\""))
        }
    }

    @Test
    fun `summary nests the limits body and carries a status map`() {
        get("/v1/summary").use { r ->
            val body = r.body!!.string()
            assertTrue(body.contains("\"limits\":{"))
            assertTrue(body.contains("\"weekly_all\""))
            assertTrue(body.contains("\"status\":{"))
            assertTrue(body.contains("\"thresholds\":{"))
        }
    }

    @Test
    fun `sessions carries a weak etag and answers 304 when it matches`() {
        val etag = get("/v1/sessions").use { r ->
            assertEquals(200, r.code)
            assertEquals(3, Regex("\"sessionId\"").findAll(r.body!!.string()).count())
            r.header("ETag")
        }
        assertNotNull(etag)
        get("/v1/sessions", etag = etag).use { r -> assertEquals(304, r.code) }
    }

    @Test
    fun `tokens only answers groupBy project`() {
        get("/v1/tokens?since=today&groupBy=project").use { r ->
            assertEquals(200, r.code)
            assertTrue(r.body!!.string().contains("\"groups\""))
        }
        get("/v1/tokens?since=today&groupBy=model").use { r -> assertEquals(400, r.code) }
    }

    @Test
    fun `a mutating request without the token is refused with the error envelope`() {
        post("/v1/pause", """{"scope":"all","mode":"soft","reason":"x"}""", token = null).use { r ->
            assertEquals(401, r.code)
            val body = r.body!!.string()
            assertTrue(body.contains("\"code\":\"unauthorized\""))
            assertTrue(body.contains("\"message\""))
        }
    }

    @Test
    fun `a mutating request with the wrong token is refused`() {
        post("/v1/pause", """{"scope":"all","mode":"soft","reason":"x"}""", token = "nope").use { r ->
            assertEquals(401, r.code)
        }
    }

    @Test
    fun `pause is idempotent and returns the same rule twice`() {
        val first = post("/v1/pause", """{"scope":"all","mode":"soft","reason":"usage-deck:t"}""").use { r ->
            assertEquals(200, r.code)
            r.body!!.string()
        }
        val id = Regex("\"id\":\"([^\"]+)\"").find(first)!!.groupValues[1]
        val second = post("/v1/pause", """{"scope":"all","mode":"soft","reason":"usage-deck:t"}""").use { r ->
            assertEquals(200, r.code)
            r.body!!.string()
        }
        assertEquals(id, Regex("\"id\":\"([^\"]+)\"").find(second)!!.groupValues[1])
        assertEquals(1, daemon.state.rules.size)

        get("/v1/pause/rules").use { r ->
            assertEquals(200, r.code)
            assertTrue(r.body!!.string().contains("usage-deck:t"))
        }
    }

    @Test
    fun `a soft pause marks its sessions paused and resume clears them`() {
        post("/v1/pause", """{"scope":"all","mode":"soft","reason":"usage-deck:t"}""").use { r ->
            assertTrue(r.body!!.string().contains("\"affected\""))
        }
        assertTrue(daemon.state.sessions.all { it.pause != null })

        post("/v1/resume", """{"scope":"all"}""").use { r ->
            assertEquals(200, r.code)
            assertTrue(r.body!!.string().contains("\"removed\""))
        }
        assertTrue(daemon.state.sessions.all { it.pause == null })
        assertTrue(daemon.state.rules.isEmpty())
    }

    @Test
    fun `resume with nothing to remove is still a 200 with empty arrays`() {
        post("/v1/resume", """{"scope":"session:nope"}""").use { r ->
            assertEquals(200, r.code)
            assertEquals("""{"removed":[],"resumed":[]}""", r.body!!.string())
        }
    }

    @Test
    fun `hard pause on a transcript-discovered session is a 409`() {
        val transcript = daemon.state.sessions.first { it.discovered == "transcript" }
        post("/v1/pause", """{"scope":"session:${transcript.sessionId}","mode":"hard","reason":"x"}""").use { r ->
            assertEquals(409, r.code)
            assertTrue(r.body!!.string().contains("\"code\":\"conflict\""))
        }
    }

    @Test
    fun `pause on an unknown session is a 410`() {
        post("/v1/pause", """{"scope":"session:nope","mode":"soft","reason":"x"}""").use { r ->
            assertEquals(410, r.code)
            assertTrue(r.body!!.string().contains("\"code\":\"gone\""))
        }
    }

    @Test
    fun `deleting a rule by id removes it and an unknown id is a 404`() {
        val body = post("/v1/pause", """{"scope":"all","mode":"soft","reason":"x"}""").use { it.body!!.string() }
        val id = Regex("\"id\":\"([^\"]+)\"").find(body)!!.groupValues[1]
        delete("/v1/pause/rules/$id").use { r -> assertEquals(204, r.code) }
        assertTrue(daemon.state.rules.isEmpty())
        delete("/v1/pause/rules/$id").use { r -> assertEquals(404, r.code) }
    }

    @Test
    fun `the first SSE event is a snapshot and emitted events follow`() {
        val request = Request.Builder()
            .url(url("/v1/events"))
            .header("Accept", "text/event-stream")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            assertEquals(200, response.code)
            assertTrue(response.header("Content-Type")!!.startsWith("text/event-stream"))
            val source = response.body!!.source()

            val firstEvent = generateSequence { source.readUtf8Line() }.first { it.startsWith("event:") }
            assertEquals("event: snapshot", firstEvent)
            val data = generateSequence { source.readUtf8Line() }.first { it.startsWith("data:") }
            assertTrue(data.contains("\"summary\""))
            assertTrue(data.contains("\"sessions\""))

            daemon.emit("heartbeat", "{}")
            val next = generateSequence { source.readUtf8Line() }.first { it.startsWith("event:") }
            assertEquals("event: heartbeat", next)
        }
    }

    @Test
    fun `warnCrossing walks weekly_all past both thresholds`() {
        val d = FakeDaemon(port = ServerSocket(0).use { it.localPort }, scenario = Scenarios.warnCrossing)
        d.start()
        try {
            assertEquals(70, d.state.limit("weekly_all")!!.percent)
            assertEquals("ok", d.state.status.byId["weekly_all"])
            repeat(4) { d.tick() }
            assertEquals(82, d.state.limit("weekly_all")!!.percent)
            assertEquals("warn", d.state.status.byId["weekly_all"])
            repeat(5) { d.tick() }
            assertEquals(97, d.state.limit("weekly_all")!!.percent)
            assertEquals("critical", d.state.status.byId["weekly_all"])
            repeat(5) { d.tick() }
            assertEquals("it stops at 97", 97, d.state.limit("weekly_all")!!.percent)
        } finally {
            d.stop()
        }
    }

    @Test
    fun `freeze hard-freezes the first session at step three`() {
        val d = FakeDaemon(port = ServerSocket(0).use { it.localPort }, scenario = Scenarios.freeze)
        d.start()
        try {
            repeat(2) { d.tick() }
            assertTrue(d.state.sessions.first().pause == null)
            d.tick()
            val pause = d.state.sessions.first().pause!!
            assertEquals("hard", pause.mode)
            assertTrue(pause.frozenPids.isNotEmpty())
            assertEquals(1, d.state.rules.size)
        } finally {
            d.stop()
        }
    }

    @Test
    fun `machineDrop stops and later resumes heartbeats`() {
        val d = FakeDaemon(port = ServerSocket(0).use { it.localPort }, scenario = Scenarios.machineDrop)
        d.start()
        try {
            assertTrue(d.state.heartbeats)
            repeat(6) { d.tick() }
            assertTrue("heartbeats stop after step 5", !d.state.heartbeats)
            repeat(90) { d.tick() }
            assertTrue("heartbeats come back after three minutes", d.state.heartbeats)
        } finally {
            d.stop()
        }
    }

    @Test
    fun `scenarios resolve by name and default to idle`() {
        assertEquals("idle", Scenarios.byName("idle").name)
        assertEquals("warnCrossing", Scenarios.byName("warnCrossing").name)
        assertEquals("freeze", Scenarios.byName("freeze").name)
        assertEquals("machineDrop", Scenarios.byName("machineDrop").name)
        assertEquals("idle", Scenarios.byName("nonsense").name)
    }

    @Test
    fun `args parse port scenario and token with a 47299 default port`() {
        val defaults = Args.parse(emptyArray())
        assertEquals(47299, defaults.port)
        assertEquals("idle", defaults.scenario.name)

        val parsed = Args.parse(arrayOf("--port", "1234", "--scenario", "freeze", "--token", "zzz"))
        assertEquals(1234, parsed.port)
        assertEquals("freeze", parsed.scenario.name)
        assertEquals("zzz", parsed.token)
    }
}
