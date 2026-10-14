// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.fakedaemon

import com.evenseal.usagedeck.core.daemon.ErrorBodyDto
import com.evenseal.usagedeck.core.daemon.ErrorEnvelopeDto
import com.evenseal.usagedeck.core.daemon.HealthDto
import com.evenseal.usagedeck.core.daemon.LastToolDto
import com.evenseal.usagedeck.core.daemon.LimitDto
import com.evenseal.usagedeck.core.daemon.LimitScopeDto
import com.evenseal.usagedeck.core.daemon.LimitsBodyDto
import com.evenseal.usagedeck.core.daemon.PauseRequestDto
import com.evenseal.usagedeck.core.daemon.PauseResponseDto
import com.evenseal.usagedeck.core.daemon.PauseRuleDto
import com.evenseal.usagedeck.core.daemon.PauseStateDto
import com.evenseal.usagedeck.core.daemon.PinnedTls
import com.evenseal.usagedeck.core.daemon.ProjectRefDto
import com.evenseal.usagedeck.core.daemon.ResumeRequestDto
import com.evenseal.usagedeck.core.daemon.ResumeResponseDto
import com.evenseal.usagedeck.core.daemon.RulesDto
import com.evenseal.usagedeck.core.daemon.SessionDto
import com.evenseal.usagedeck.core.daemon.SessionsDto
import com.evenseal.usagedeck.core.daemon.StatusDto
import com.evenseal.usagedeck.core.daemon.SummaryDto
import com.evenseal.usagedeck.core.daemon.ThresholdsDto
import com.evenseal.usagedeck.core.daemon.TokensCountsDto
import com.evenseal.usagedeck.core.daemon.TokensDto
import com.evenseal.usagedeck.core.daemon.TokensGroupDto
import com.evenseal.usagedeck.core.daemon.UpdateDto
import com.evenseal.usagedeck.core.daemon.UserDto
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.applicationEngineEnvironment
import io.ktor.server.engine.connector
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.tls.HeldCertificate

/** Encodes defaults so empty arrays stay `[]` on the wire, as the real daemon sends them. */
val FakeJson = Json {
    encodeDefaults = true
    explicitNulls = false
    ignoreUnknownKeys = true
}

/** Everything a scenario is allowed to move. */
class FakeState(
    var name: String,
    var version: String = "0.1.417+fake",
    var user: UserDto = DEFAULT_USER,
    var limits: List<LimitDto> = defaultLimits(),
    var status: StatusDto = defaultStatus(),
    var thresholds: ThresholdsDto = ThresholdsDto(),
    var limitsFetchedAt: String = "2026-09-13T14:00:00Z",
    var today: TokensCountsDto = DEFAULT_TODAY,
    var sessions: List<SessionDto> = defaultSessions(),
    var rules: List<PauseRuleDto> = emptyList(),
    var update: UpdateDto = UpdateDto(current = "0.1.417+fake", state = "idle"),
    var projectGroups: List<TokensGroupDto> = defaultGroups(),
    var rev: Long = 1,
    var heartbeats: Boolean = true,
    /** `claude-usage configure rotate-token` happened: the deck's token is rejected from now on. */
    var tokenRotated: Boolean = false
) {
    fun limit(id: String): LimitDto? = limits.firstOrNull { it.id == id }

    fun setLimit(id: String, limit: LimitDto) {
        limits = limits.map { if (it.id == id) limit else it }
    }

    fun setStatus(id: String, value: String) {
        status = status.copy(byId = status.byId + (id to value))
    }

    fun session(id: String): SessionDto? = sessions.firstOrNull { it.sessionId == id }

    fun replaceSession(session: SessionDto) {
        sessions = sessions.map { if (it.sessionId == session.sessionId) session else it }
    }

    fun bumpRev() {
        rev += 1
    }

    fun limitsBody() = LimitsBodyDto(limits = limits, fetchedAt = limitsFetchedAt, stale = false, error = null)

    fun summary() = SummaryDto(
        limits = limitsBody(),
        status = status,
        thresholds = thresholds,
        today = today
    )

    fun sessionsBody() = SessionsDto(rev = rev, sessions = sessions)

    fun rulesBody() = RulesDto(rev = rev, rules = rules)

    fun health() = HealthDto(
        ok = true,
        version = version,
        uptimeMs = 864_000,
        pid = 4242,
        name = name,
        user = user,
        update = update
    )

    companion object {
        val DEFAULT_USER = UserDto(
            emailAddress = "adam@example.test",
            accountUuid = "c0ffee00-1111-4222-8333-444455556666",
            organizationUuid = "d1a9b0c2-7777-4888-8999-aaaabbbbcccc",
            displayName = "Adam Example"
        )

        val DEFAULT_TODAY = TokensCountsDto(
            input = 4_200_000,
            output = 318_000,
            cacheCreate = 200_000,
            cacheRead = 9_000_000,
            messages = 600
        )

        fun defaultLimits() = listOf(
            LimitDto(
                id = "session",
                kind = "session",
                group = "session",
                percent = 42,
                resetsAt = "2026-09-13T16:35:00Z",
                isActive = false
            ),
            LimitDto(
                id = "weekly_all",
                kind = "weekly_all",
                group = "weekly",
                percent = 62,
                resetsAt = "2026-09-18T09:00:00Z",
                isActive = true
            ),
            LimitDto(
                id = "weekly_scoped:fable",
                kind = "weekly_scoped",
                group = "weekly",
                percent = 10,
                resetsAt = null,
                scope = LimitScopeDto(model = "Fable"),
                isActive = false
            )
        )

        fun defaultStatus() = StatusDto(
            byId = mapOf("session" to "ok", "weekly_all" to "ok", "weekly_scoped:fable" to "ok"),
            overall = "ok"
        )

        /**
         * The daemon's `test/fixtures/sessions/sessions.json` (two hook-registered worktrees of one
         * repo and a dead transcript-only session), started unpaused, plus one live transcript-only
         * session so the 409 "no trusted pid" path is reachable as well as the 410 "exited" one.
         */
        fun defaultSessions() = listOf(
            SessionDto(
                sessionId = "3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411",
                pid = 4242,
                alive = true,
                discovered = "hook",
                cwd = "/Users/adam/code/foo-wt2",
                transcriptPath =
                "/Users/adam/.claude/projects/-Users-adam-code-foo-wt2/3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411.jsonl",
                project = ProjectRefDto("/Users/adam/code/foo/.git", "foo"),
                worktree = "foo-wt2",
                model = "claude-opus-5",
                startedAt = "2026-09-13T11:04:18.000Z",
                lastActivityAt = "2026-09-13T14:02:51.000Z",
                tokens = TokensCountsDto(18_422, 5_310, 240_118, 1_904_772, 143),
                lastTool = LastToolDto("Bash", "2026-09-13T14:02:50.000Z")
            ),
            SessionDto(
                sessionId = "8ad4e017-5b22-4c90-9f3d-7e6b1a0c3350",
                pid = 4390,
                alive = true,
                discovered = "hook",
                cwd = "/Users/adam/code/foo",
                transcriptPath =
                "/Users/adam/.claude/projects/-Users-adam-code-foo/8ad4e017-5b22-4c90-9f3d-7e6b1a0c3350.jsonl",
                project = ProjectRefDto("/Users/adam/code/foo/.git", "foo"),
                model = "claude-fable-5-1",
                startedAt = "2026-09-13T13:40:02.000Z",
                lastActivityAt = "2026-09-13T14:01:07.000Z",
                tokens = TokensCountsDto(2_201, 940, 31_002, 288_140, 21)
            ),
            SessionDto(
                sessionId = "c70bd853-62b1-4f42-8c14-2b7dcfe6578c",
                pid = null,
                alive = false,
                discovered = "transcript",
                cwd = "/Users/adam/code/notes",
                project = ProjectRefDto(null, "notes"),
                model = "claude-haiku-4-5",
                startedAt = "2026-09-12T21:15:44.000Z",
                lastActivityAt = "2026-09-12T22:48:03.000Z",
                tokens = TokensCountsDto(812, 306, 0, 14_022, 9)
            ),
            SessionDto(
                sessionId = "b91f77a0-3c48-4d6e-9a20-5e1c8f0b2d34",
                pid = null,
                alive = true,
                discovered = "transcript",
                cwd = "/Users/adam/code/scratch",
                project = ProjectRefDto(null, "scratch"),
                model = "claude-haiku-4-5",
                startedAt = "2026-09-13T10:02:11.000Z",
                lastActivityAt = "2026-09-13T13:58:40.000Z",
                tokens = TokensCountsDto(4_100, 902, 0, 22_500, 17)
            )
        )

        fun defaultGroups() = listOf(
            TokensGroupDto(
                key = "-Users-adam-code-foo",
                label = "/Users/adam/code/foo",
                input = 20_623,
                output = 6_250,
                cacheCreate = 271_120,
                cacheRead = 2_192_912,
                messages = 164
            ),
            TokensGroupDto(
                key = "-Users-adam-code-notes",
                label = "/Users/adam/code/notes",
                input = 812,
                output = 306,
                cacheRead = 14_022,
                messages = 9
            )
        )
    }
}

@Serializable
private data class SnapshotBody(
    val name: String,
    val version: String,
    val user: UserDto,
    val limits: LimitsBodyDto,
    val summary: SummaryDto,
    /** A bare array, as the real daemon sends it — not the `/v1/sessions` body. */
    val sessions: List<SessionDto>,
    val rules: RulesDto,
    val update: UpdateDto,
    val rev: Long
)

@Serializable
private data class LivenessBody(val ok: Boolean = true)

@Serializable
private data class PairRequestBody(val code: String = "")

@Serializable
private data class PairResponseBody(val token: String, val name: String, val fp: String)

@Serializable
private data class HeartbeatBody(val rev: Long, val at: String)

@Serializable
private data class PauseEventBody(val rules: List<PauseRuleDto>, val affected: List<String>)

/**
 * A Ktor stand-in for `claude-usage` implementing the dashboard contract, so the app runs on an
 * emulator with no Mac in the loop.
 *
 * It listens the way the real daemon does: plain HTTP on loopback only ([port], default 47299 —
 * the real daemon owns 47291) and pinned HTTPS on [tlsPort], which is the only listener a deck
 * may use. HTTPS binds [bind], loopback unless the caller opts into another address; the Android
 * emulator reaches the host's loopback as `10.0.2.2`, so the default already serves it.
 *
 * There is no well-known token: one is generated per instance unless the caller passes its own.
 * Every request needs it as a bearer, except `POST /v1/pair` (HTTPS only; trades a one-time code
 * from [pairingLink] for the token) and `GET /health`, which without the bearer answers liveness
 * and nothing else.
 */
class FakeDaemon(
    val port: Int = DEFAULT_PORT,
    val token: String = newSecret(TOKEN_BYTES),
    val name: String = "fake-mbp",
    private val scenario: Scenario = Scenarios.idle,
    /** The HTTPS port; 0 picks a free one. Read it back after [start]. */
    tlsPort: Int = 0,
    val bind: String = LOOPBACK
) {
    val state = FakeState(name = name)

    var tlsPort: Int = tlsPort
        private set

    private val certificate = HeldCertificate.Builder().commonName("claude-usage").ecdsa256().build()

    /** What a pairing link carries as `fp`: lowercase hex SHA-256 of the certificate's public key. */
    val fingerprint: String = PinnedTls.fingerprint(certificate.certificate)

    private val clients = CopyOnWriteArrayList<Channel<String>>()
    private val steps = AtomicInteger(0)
    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var engine: ApplicationEngine? = null
    private var tlsFront: TlsFront? = null

    /** Where the TLS front forwards to; only requests arriving here may redeem a pairing code. */
    private var tlsBackendPort = 0

    private val pairingLock = Any()
    private var pairingCode: String? = null
    private var pairingFailures = 0

    /** Called after a code has been redeemed, so a CLI can print the next link. */
    var onPaired: () -> Unit = {}

    fun start() {
        if (engine != null) return
        scenario.init(state)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        tlsBackendPort = freePort()
        val environment = applicationEngineEnvironment {
            connector {
                host = LOOPBACK
                port = this@FakeDaemon.port
            }
            connector {
                host = LOOPBACK
                port = tlsBackendPort
            }
            module { routes() }
        }
        val server = embeddedServer(CIO, environment)
        server.start(wait = false)
        runBlocking { server.resolvedConnectors() }
        engine = server
        tlsFront = TlsFront(certificate, bind, tlsPort, tlsBackendPort).also {
            it.start()
            tlsPort = it.port
        }
        scope.launch {
            while (isActive) {
                delay(HEARTBEAT_MS)
                if (state.heartbeats) {
                    emit("heartbeat", FakeJson.encodeToString(HeartbeatBody(state.rev, Instant.now().toString())))
                }
            }
        }
    }

    fun stop() {
        scope.cancel()
        clients.forEach { it.close() }
        clients.clear()
        tlsFront?.stop()
        tlsFront = null
        engine?.stop(0, 0)
        engine = null
    }

    /**
     * Mints a fresh one-time code (replacing any unredeemed one) and returns the link
     * `claude-usage pair` would print: `usagedeck://pair?v=2&name&addrs&port&fp&code`.
     */
    fun pairingLink(addrs: List<String> = listOf(LOOPBACK)): String {
        val code = newSecret(CODE_BYTES)
        synchronized(pairingLock) { pairingCode = code }
        fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8.name()).replace("+", "%20")
        return "usagedeck://pair?v=2&name=${enc(state.name)}&addrs=${enc(addrs.joinToString(","))}" +
            "&port=$tlsPort&fp=$fingerprint&code=$code"
    }

    /** Pushes one frame to every connected SSE client. */
    fun emit(event: String, data: String) {
        val frame = "event: $event\ndata: $data\n\n"
        clients.forEach { it.trySend(frame) }
    }

    /** Advances the scenario by one step; the CLI calls this every two seconds. */
    fun tick() {
        scenario.step(state, steps.incrementAndGet(), ::emit)
    }

    // ---- routes ------------------------------------------------------------------------------

    private fun io.ktor.server.application.Application.routes() = routing {
        // Liveness for anyone; the body that names the machine and its user needs the bearer.
        get("/health") {
            if (authorized(call)) call.json(state.health()) else call.json(LivenessBody())
        }

        post("/v1/pair") { handlePair(call) }

        get("/v1/summary") { guarded { call.json(state.summary()) } }

        get("/v1/limits") { guarded { call.json(state.limitsBody()) } }

        get("/v1/sessions") {
            guarded {
                val etag = "W/\"${state.rev}\""
                if (call.request.headers["If-None-Match"] == etag) {
                    call.response.header("ETag", etag)
                    call.respond(HttpStatusCode.NotModified)
                } else {
                    call.response.header("ETag", etag)
                    call.json(state.sessionsBody())
                }
            }
        }

        get("/v1/tokens") {
            guarded {
                if (call.request.queryParameters["groupBy"] != "project") {
                    call.error(HttpStatusCode.BadRequest, "bad_request", "groupBy must be project")
                } else {
                    call.json(TokensDto(ready = true, groups = state.projectGroups))
                }
            }
        }

        get("/v1/pause/rules") { guarded { call.json(state.rulesBody()) } }

        post("/v1/pause") { guarded { handlePause(call) } }

        post("/v1/resume") { guarded { handleResume(call) } }

        delete("/v1/pause/rules/{id}") {
            guarded {
                val id = call.parameters["id"]
                val existing = state.rules.firstOrNull { it.id == id }
                if (existing == null) {
                    call.error(HttpStatusCode.NotFound, "not_found", "No rule $id")
                } else {
                    removeRules { it.id != id }
                    call.respond(HttpStatusCode.NoContent)
                }
            }
        }

        get("/v1/events") { guarded { streamEvents(call) } }
    }

    private suspend fun handlePause(call: ApplicationCall) {
        val request = runCatching { FakeJson.decodeFromString<PauseRequestDto>(call.receiveText()) }.getOrNull()
        if (request == null) {
            call.error(HttpStatusCode.BadRequest, "bad_request", "Body must be {scope, mode, reason}")
            return
        }
        if (request.scope.startsWith(SESSION_PREFIX)) {
            val id = request.scope.removePrefix(SESSION_PREFIX)
            val session = state.session(id)
            // Unknown or exited → 410 and no rule is created; a live session with no trusted pid → 409.
            if (session == null || !session.alive) {
                call.error(HttpStatusCode.Gone, "gone", "session $id has exited")
                return
            }
            if (request.mode == "hard" && (session.discovered == "transcript" || session.pid == null)) {
                call.error(
                    HttpStatusCode.Conflict,
                    "conflict",
                    "session $id was discovered from its transcript and has no trusted pid"
                )
                return
            }
        }

        val existing = state.rules.firstOrNull { it.scope == request.scope && it.mode == request.mode }
        val rule = existing ?: PauseRuleDto(
            id = "r-${state.rules.size + 1}-${request.mode}",
            scope = request.scope,
            mode = request.mode,
            reason = request.reason,
            createdAt = Instant.now().toString(),
            createdBy = "dashboard"
        )
        if (existing == null) state.rules = state.rules + rule

        val affected = matching(request.scope)
        affected.forEach { session ->
            state.replaceSession(
                session.copy(
                    pause = PauseStateDto(
                        mode = request.mode,
                        ruleId = rule.id,
                        scope = request.scope,
                        since = rule.createdAt,
                        // §23.16: only tool subprocesses are stopped, never the session's own pid; the
                        // fake has no subprocesses, so a hard pause is "held at the gate" with freezes 1.
                        frozenPids = emptyList(),
                        freezes = if (request.mode == "hard") (session.pause?.freezes ?: 0) + 1 else 0
                    )
                )
            )
        }
        state.bumpRev()
        emitPause(affected.map { it.sessionId })
        call.json(PauseResponseDto(rule, affected.map { it.sessionId }))
    }

    private suspend fun handleResume(call: ApplicationCall) {
        val request = runCatching { FakeJson.decodeFromString<ResumeRequestDto>(call.receiveText()) }.getOrNull()
        if (request == null) {
            call.error(HttpStatusCode.BadRequest, "bad_request", "Body must be {scope}")
            return
        }
        val removed = state.rules.filter { it.scope == request.scope }.map { it.id }
        removeRules { it.scope != request.scope }
        val resumed = state.sessions.filter { it.pause?.scope == request.scope }.map { it.sessionId }
        resumed.forEach { id -> state.session(id)?.let { state.replaceSession(it.copy(pause = null)) } }
        if (removed.isNotEmpty() || resumed.isNotEmpty()) {
            state.bumpRev()
            emitPause(resumed)
        }
        call.json(ResumeResponseDto(removed, resumed))
    }

    private fun removeRules(keep: (PauseRuleDto) -> Boolean) {
        val dropped = state.rules.filterNot(keep)
        state.rules = state.rules.filter(keep)
        dropped.forEach { rule ->
            state.sessions.filter { it.pause?.ruleId == rule.id }.forEach { session ->
                state.replaceSession(session.copy(pause = null))
            }
        }
    }

    private fun matching(scope: String): List<SessionDto> = when {
        scope == "all" -> state.sessions
        scope.startsWith(PROJECT_PREFIX) -> {
            val key = scope.removePrefix(PROJECT_PREFIX)
            state.sessions.filter { (it.project.gitCommonDir ?: it.cwd) == key }
        }
        scope.startsWith(SESSION_PREFIX) -> listOfNotNull(state.session(scope.removePrefix(SESSION_PREFIX)))
        else -> emptyList()
    }

    private fun emitPause(affected: List<String>) {
        emit("pause", FakeJson.encodeToString(PauseEventBody(state.rules, affected)))
    }

    private suspend fun streamEvents(call: ApplicationCall) {
        val channel = Channel<String>(Channel.UNLIMITED)
        clients += channel
        try {
            call.respondTextWriter(contentType = ContentType.parse("text/event-stream")) {
                write("retry: 3000\n\n")
                flush()
                write("id: ${state.rev}\nevent: snapshot\ndata: ${snapshotJson()}\n\n")
                flush()
                for (frame in channel) {
                    write(frame)
                    flush()
                }
            }
        } finally {
            clients -= channel
            channel.close()
        }
    }

    private fun snapshotJson(): String = FakeJson.encodeToString(
        SnapshotBody(
            name = state.name,
            version = state.version,
            user = state.user,
            limits = state.limitsBody(),
            summary = state.summary(),
            sessions = state.sessions,
            rules = state.rulesBody(),
            update = state.update,
            rev = state.rev
        )
    )

    // ---- helpers -----------------------------------------------------------------------------

    /**
     * `POST /v1/pair {"code"}` (daemon §23.47): no bearer, HTTPS only, single use. A wrong code is
     * a 401, and after [MAX_PAIR_FAILURES] of them every attempt is a 429 until a new link is minted.
     */
    private suspend fun handlePair(call: ApplicationCall) {
        if (call.request.local.localPort != tlsBackendPort) {
            call.error(HttpStatusCode.NotFound, "not_found", "Pairing is served over HTTPS only")
            return
        }
        val offered = runCatching { FakeJson.decodeFromString<PairRequestBody>(call.receiveText()).code }.getOrNull()
        val outcome = synchronized(pairingLock) {
            val expected = pairingCode
            when {
                pairingFailures >= MAX_PAIR_FAILURES -> HttpStatusCode.TooManyRequests
                offered != null && expected != null && MessageDigest.isEqual(
                    offered.toByteArray(Charsets.UTF_8),
                    expected.toByteArray(Charsets.UTF_8)
                ) -> {
                    pairingCode = null
                    pairingFailures = 0
                    HttpStatusCode.OK
                }
                else -> {
                    pairingFailures++
                    HttpStatusCode.Unauthorized
                }
            }
        }
        when (outcome) {
            HttpStatusCode.OK -> {
                call.json(PairResponseBody(token, state.name, fingerprint))
                onPaired()
            }
            HttpStatusCode.TooManyRequests -> call.error(outcome, "rate_limited", "Too many pairing attempts")
            else -> call.error(outcome, "unauthorized", "Pairing code invalid or expired")
        }
    }

    /** Every request needs the bearer token, from loopback too (daemon spec §16 as hardened). */
    private fun authorized(call: ApplicationCall): Boolean {
        // After a rotation nothing the deck holds is valid.
        if (state.tokenRotated) return false
        val offered = call.request.headers["Authorization"].orEmpty().toByteArray(Charsets.UTF_8)
        return MessageDigest.isEqual(offered, "Bearer $token".toByteArray(Charsets.UTF_8))
    }

    private suspend fun io.ktor.util.pipeline.PipelineContext<Unit, ApplicationCall>.guarded(
        block: suspend () -> Unit
    ) {
        if (!authorized(call)) {
            call.error(HttpStatusCode.Unauthorized, "unauthorized", "Bearer token missing or invalid")
            return
        }
        block()
    }

    companion object {
        const val DEFAULT_PORT = 47299
        const val LOOPBACK = "127.0.0.1"

        private const val TOKEN_BYTES = 32
        private const val CODE_BYTES = 24
        private const val MAX_PAIR_FAILURES = 5
        private const val HEARTBEAT_MS = 15_000L
        private const val SESSION_PREFIX = "session:"
        private const val PROJECT_PREFIX = "project:"

        /** Unpadded base64url of [bytes] random bytes: a token or a pairing code. */
        fun newSecret(bytes: Int): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
            ByteArray(bytes).also { SecureRandom().nextBytes(it) }
        )

        private fun freePort(): Int = ServerSocket(0, 1, InetAddress.getByName(LOOPBACK)).use { it.localPort }
    }
}

private suspend inline fun <reified T> ApplicationCall.json(body: T) {
    respondText(FakeJson.encodeToString(body), ContentType.Application.Json)
}

private suspend fun ApplicationCall.error(status: HttpStatusCode, code: String, message: String) {
    respondText(
        FakeJson.encodeToString(ErrorEnvelopeDto(ErrorBodyDto(code, message, null))),
        ContentType.Application.Json,
        status
    )
}
