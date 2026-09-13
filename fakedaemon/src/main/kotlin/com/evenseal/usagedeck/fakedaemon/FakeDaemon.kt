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
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.origin
import io.ktor.server.request.httpMethod
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import java.time.Instant
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
    var heartbeats: Boolean = true
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
            emailAddress = "alan@example.test",
            accountUuid = "c0ffee00-1111-4222-8333-444455556666",
            organizationUuid = "d1a9b0c2-7777-4888-8999-aaaabbbbcccc",
            displayName = "Alan Example"
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

        /** The three sessions from the daemon fixtures: two hook-registered, one transcript-only. */
        fun defaultSessions() = listOf(
            SessionDto(
                sessionId = "7f3a9c2e-1111-4b2b-9c1d-000000000001",
                pid = 48211,
                alive = true,
                discovered = "hook",
                cwd = "/Users/alan/code/calendarpa",
                transcriptPath = "/Users/alan/.claude/projects/-Users-alan-code-calendarpa/7f3a.jsonl",
                project = ProjectRefDto("/Users/alan/code/calendarpa/.git", "calendarpa"),
                model = "claude-opus-5",
                startedAt = "2026-09-13T11:20:00Z",
                lastActivityAt = "2026-09-13T14:01:58Z",
                tokens = TokensCountsDto(1_200_000, 48_000, 90_000, 3_100_000, 210),
                lastTool = LastToolDto("Read", "2026-09-13T14:01:58Z")
            ),
            SessionDto(
                sessionId = "c21e0000-2222-4b2b-9c1d-000000000002",
                pid = 48990,
                alive = true,
                discovered = "hook",
                cwd = "/Users/alan/code/calendarpa-wt/billing",
                project = ProjectRefDto("/Users/alan/code/calendarpa/.git", "calendarpa"),
                worktree = "billing",
                model = "claude-sonnet-5",
                startedAt = "2026-09-13T13:05:00Z",
                lastActivityAt = "2026-09-13T14:01:40Z",
                tokens = TokensCountsDto(410_000, 20_000, 0, 900_000, 80)
            ),
            SessionDto(
                sessionId = "4d090000-3333-4b2b-9c1d-000000000003",
                pid = null,
                alive = true,
                discovered = "transcript",
                cwd = "/Users/alan/code/audioleveler",
                transcriptPath = "/Users/alan/.claude/projects/-Users-alan-code-audioleveler/4d09.jsonl",
                project = ProjectRefDto(null, "audioleveler"),
                startedAt = "2026-09-13T09:00:00Z",
                lastActivityAt = "2026-09-13T09:40:00Z",
                tokens = TokensCountsDto(520_000, 9_000, 0, 0, 30)
            )
        )

        fun defaultGroups() = listOf(
            TokensGroupDto(
                key = "-Users-alan-code-calendarpa",
                label = "/Users/alan/code/calendarpa",
                input = 1_600_000,
                output = 142_000,
                cacheCreate = 90_000,
                cacheRead = 4_000_000,
                messages = 312
            ),
            TokensGroupDto(
                key = "-Users-alan-code-audioleveler",
                label = "/Users/alan/code/audioleveler",
                input = 520_000,
                output = 9_000,
                messages = 30
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
    val sessions: SessionsDto,
    val rules: RulesDto,
    val update: UpdateDto,
    val rev: Long
)

@Serializable
private data class HeartbeatBody(val rev: Long, val at: String)

@Serializable
private data class PauseEventBody(val rules: List<PauseRuleDto>, val affected: List<String>)

/**
 * A Ktor stand-in for `claude-usage` implementing the dashboard contract, so the app runs on an
 * emulator with no Mac in the loop. Defaults to port 47299 — the real daemon owns 47291.
 */
class FakeDaemon(
    val port: Int = DEFAULT_PORT,
    val token: String = "fake-token",
    val name: String = "fake-mbp",
    private val scenario: Scenario = Scenarios.idle
) {
    val state = FakeState(name = name)

    private val clients = CopyOnWriteArrayList<Channel<String>>()
    private val steps = AtomicInteger(0)
    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var engine: ApplicationEngine? = null

    fun start() {
        if (engine != null) return
        scenario.init(state)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val server = embeddedServer(CIO, port = port, host = "0.0.0.0") { routes() }
        server.start(wait = false)
        runBlocking { server.resolvedConnectors() }
        engine = server
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
        engine?.stop(0, 0)
        engine = null
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
        get("/health") { guarded { call.json(state.health()) } }

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
            val session = state.session(request.scope.removePrefix(SESSION_PREFIX))
            if (session == null) {
                call.error(HttpStatusCode.Gone, "gone", "Session ended; pause cleared.")
                return
            }
            if (request.mode == "hard" && (session.discovered == "transcript" || session.pid == null)) {
                call.error(HttpStatusCode.Conflict, "conflict", "That session has no trusted pid.")
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
                        frozenPids = if (request.mode == "hard") listOfNotNull(session.pid) else emptyList()
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
            sessions = state.sessionsBody(),
            rules = state.rulesBody(),
            update = state.update,
            rev = state.rev
        )
    )

    // ---- helpers -----------------------------------------------------------------------------

    /** Loopback GETs are exempt; every other request needs the bearer token (daemon spec §16). */
    private fun authorized(call: ApplicationCall): Boolean {
        val safe = call.request.httpMethod == HttpMethod.Get || call.request.httpMethod == HttpMethod.Head
        if (safe && isLoopback(call)) return true
        return call.request.headers["Authorization"] == "Bearer $token"
    }

    private fun isLoopback(call: ApplicationCall): Boolean {
        val host = runCatching { call.request.origin.remoteHost }.getOrNull().orEmpty()
        return host.startsWith("127.") || host == "::1" || host == "0:0:0:0:0:0:0:1" || host == "localhost"
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

    private companion object {
        const val DEFAULT_PORT = 47299
        const val HEARTBEAT_MS = 15_000L
        const val SESSION_PREFIX = "session:"
        const val PROJECT_PREFIX = "project:"
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
