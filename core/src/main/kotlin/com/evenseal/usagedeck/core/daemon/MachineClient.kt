package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.model.Aging
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.Session
import java.time.Instant
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns one machine's live [MachineState].
 *
 * Runs an SSE connection loop with backoff; after two consecutive connects that never reached
 * [Connection.Open] it also starts REST polling (2 s with the screen on, 30 s otherwise) and
 * keeps polling until SSE opens again. A ticker re-derives [com.evenseal.usagedeck.core.model.Health]
 * from `lastHeartbeatAt`, and project token totals refresh every 30 s. Errors never escape;
 * they land in `state.lastError`.
 */
class MachineClient(
    val config: MachineConfig,
    private val api: DaemonApi,
    private val eventSource: () -> Flow<Any>,
    private val burn: BurnHistory,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val screenOn: StateFlow<Boolean>,
    private val tickerMs: Long = 1000
) {
    private val _state = MutableStateFlow(MachineState(config))
    val state: StateFlow<MachineState> = _state.asStateFlow()

    private val jobs = mutableListOf<Job>()
    private var pollingJob: Job? = null
    private var etag: String? = null
    private var lastStatus: StatusDto = StatusDto()
    private var thresholds: ThresholdsDto = ThresholdsDto()

    fun start() {
        if (jobs.isNotEmpty()) return
        jobs += scope.launch { connectionLoop() }
        jobs += scope.launch { agingLoop() }
        jobs += scope.launch { projectTokensLoop() }
    }

    fun stop() {
        stopPolling()
        jobs.forEach { it.cancel() }
        jobs.clear()
    }

    fun burnKeyForSession(sessionId: String) = "${config.id}/s/$sessionId"

    fun burnKeyForProject(projectKey: String) = "${config.id}/p/$projectKey"

    fun burnKeyForMachine() = "${config.id}/m"

    /** `GET /v1/tokens?since=today&groupBy=project`. Failures are swallowed into `lastError`. */
    suspend fun refreshProjectTokens() {
        try {
            val dto = api.tokensByProjectToday()
            _state.update { it.copy(projectTokens = dto.groups.map { g -> g.toModel() }) }
        } catch (e: DaemonException) {
            _state.update { it.copy(lastError = e.userMessage()) }
        }
    }

    // ---- loops -------------------------------------------------------------------------------

    private suspend fun connectionLoop() {
        var failures = 0
        var backoffMs = BACKOFF_MIN_MS
        while (coroutineContext.isActive) {
            var opened = false
            eventSource()
                .onEach { item ->
                    when (item) {
                        Connection.Open -> {
                            opened = true
                            onOpen()
                        }
                        is Connection.Closed -> onClosed(item.error)
                        is DaemonEvent -> onEvent(item)
                        else -> Unit
                    }
                }
                .firstOrNull { it is Connection.Closed }

            if (opened) {
                failures = 0
                backoffMs = BACKOFF_MIN_MS
            } else {
                failures++
            }
            if (failures >= FAILURES_BEFORE_POLLING) startPolling()
            _state.update {
                it.copy(transport = if (pollingJob != null) MachineState.Transport.POLLING else it.transport)
            }
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(BACKOFF_MAX_MS)
        }
    }

    private suspend fun agingLoop() {
        while (coroutineContext.isActive) {
            delay(tickerMs)
            _state.update { it.copy(health = Aging.health(it.lastHeartbeatAt, clock.now())) }
        }
    }

    private suspend fun projectTokensLoop() {
        while (coroutineContext.isActive) {
            refreshProjectTokens()
            delay(PROJECT_TOKENS_MS)
        }
    }

    private fun startPolling() {
        if (pollingJob != null) return
        pollingJob = scope.launch {
            while (coroutineContext.isActive) {
                poll()
                delay(if (screenOn.value) POLL_SCREEN_ON_MS else POLL_SCREEN_OFF_MS)
            }
        }
        _state.update { it.copy(transport = MachineState.Transport.POLLING) }
    }

    private fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    private suspend fun poll() {
        var reachable = false
        try {
            applySummary(api.summary())
            reachable = true
        } catch (e: DaemonException) {
            _state.update { it.copy(lastError = e.userMessage()) }
        }
        try {
            when (val result = api.sessions(etag)) {
                is SessionsResult.Changed -> {
                    etag = result.etag
                    applySessions(result.dto)
                }
                SessionsResult.Unchanged -> Unit
            }
            reachable = true
        } catch (e: DaemonException) {
            _state.update { it.copy(lastError = e.userMessage()) }
        }
        if (reachable) touch()
    }

    // ---- event application -------------------------------------------------------------------

    private fun onOpen() {
        stopPolling()
        _state.update {
            it.copy(
                transport = MachineState.Transport.SSE,
                lastHeartbeatAt = clock.now(),
                health = Aging.health(clock.now(), clock.now()),
                lastError = null
            )
        }
    }

    private fun onClosed(error: DaemonException?) {
        val transport =
            if (pollingJob != null) MachineState.Transport.POLLING else MachineState.Transport.DISCONNECTED
        _state.update { it.copy(transport = transport, lastError = error?.userMessage() ?: it.lastError) }
    }

    private fun onEvent(event: DaemonEvent) {
        touch()
        when (event) {
            is DaemonEvent.Snapshot -> applySnapshot(event)
            is DaemonEvent.Limits -> applyLimits(event)
            is DaemonEvent.Spend -> applySpend(event)
            is DaemonEvent.SessionChange -> applySessionChange(event)
            is DaemonEvent.Pause -> applyPause(event)
            is DaemonEvent.Update -> _state.update { it.copy(update = event.update.toModel()) }
            is DaemonEvent.Heartbeat -> applyHeartbeat(event)
            is DaemonEvent.Unknown -> Unit
        }
    }

    /** Every event, heartbeat included, proves the daemon is alive. */
    private fun touch() {
        val now = clock.now()
        _state.update { it.copy(lastHeartbeatAt = now, health = Aging.health(now, now)) }
    }

    private fun applySnapshot(event: DaemonEvent.Snapshot) {
        val now = clock.now()
        lastStatus = event.status
        thresholds = event.thresholds
        etag = "W/\"${event.rev}\""
        val sessions = event.sessions.map { it.toModel() }
        _state.update {
            it.copy(
                name = event.name,
                version = event.version,
                user = event.user?.toModel(),
                limits = limitsOf(event.limits),
                limitsFetchedAt = now,
                today = event.today.toModel(),
                sessions = sessions,
                rules = event.rules.map { r -> r.toModel() },
                update = event.update?.toModel(),
                rev = event.rev,
                transport = MachineState.Transport.SSE
            )
        }
        burn.record(burnKeyForMachine(), now, event.today.toModel().total)
        recordSessionBurn(sessions, now)
    }

    /**
     * `lastHeartbeatAt` is already bumped by [touch] off the local clock — aging must not depend
     * on the daemon's clock — so only the revision travels with the heartbeat.
     */
    private fun applyHeartbeat(event: DaemonEvent.Heartbeat) {
        if (event.rev <= 0) return
        etag = "W/\"${event.rev}\""
        _state.update { if (event.rev > it.rev) it.copy(rev = event.rev) else it }
    }

    private fun applyLimits(event: DaemonEvent.Limits) {
        val fetchedAt = event.fetchedAt.toInstantOrNull() ?: clock.now()
        _state.update { it.copy(limits = limitsOf(event.limits), limitsFetchedAt = fetchedAt) }
    }

    /** `today` is the cumulative authority; the per-event `delta` is deliberately not used. */
    private fun applySpend(event: DaemonEvent.Spend) {
        val today = event.today.toModel()
        _state.update { it.copy(today = today) }
        burn.record(burnKeyForMachine(), clock.now(), today.total)
    }

    private fun applySessionChange(event: DaemonEvent.SessionChange) {
        val session = event.session.toModel()
        val now = clock.now()
        if (event.type == "end") {
            _state.update { it.copy(sessions = it.sessions.filterNot { s -> s.sessionId == session.sessionId }) }
            burn.forget(burnKeyForSession(session.sessionId))
        } else {
            _state.update {
                val others = it.sessions.filterNot { s -> s.sessionId == session.sessionId }
                it.copy(sessions = others + session)
            }
        }
        recordSessionBurn(_state.value.sessions, now)
    }

    private fun applyPause(event: DaemonEvent.Pause) {
        _state.update { it.copy(rules = event.rules.map { r -> r.toModel() }) }
        // Pause state lives on the sessions, so re-read them once.
        scope.launch {
            try {
                when (val result = api.sessions(null)) {
                    is SessionsResult.Changed -> {
                        etag = result.etag
                        applySessions(result.dto)
                    }
                    SessionsResult.Unchanged -> Unit
                }
            } catch (e: DaemonException) {
                _state.update { it.copy(lastError = e.userMessage()) }
            }
        }
    }

    private fun applySummary(summary: SummaryDto) {
        val now = clock.now()
        lastStatus = summary.status
        thresholds = summary.thresholds
        val today = summary.today.toModel()
        _state.update {
            it.copy(
                limits = summary.toLimits(),
                limitsFetchedAt = summary.fetchedAt.toInstantOrNull() ?: now,
                today = today
            )
        }
        burn.record(burnKeyForMachine(), now, today.total)
    }

    private fun applySessions(dto: SessionsDto) {
        val sessions = dto.sessions.map { it.toModel() }
        _state.update { it.copy(sessions = sessions, rev = dto.rev) }
        recordSessionBurn(sessions, clock.now())
    }

    private fun recordSessionBurn(sessions: List<Session>, now: Instant) {
        sessions.forEach { burn.record(burnKeyForSession(it.sessionId), now, it.tokens.total) }
        sessions.groupBy { it.projectKey }.forEach { (key, group) ->
            burn.record(burnKeyForProject(key), now, group.sumOf { it.tokens.total })
        }
    }

    /** A bare `limits` payload has no status map; reuse the last one, else derive from thresholds. */
    private fun limitsOf(limits: List<LimitDto>): List<Limit> = limits.map { dto ->
        val known = lastStatus.byId[dto.id]
        dto.toModel(if (known != null) statusOf(known) else statusFor(dto, thresholds))
    }

    private companion object {
        const val BACKOFF_MIN_MS = 3_000L
        const val BACKOFF_MAX_MS = 30_000L
        const val FAILURES_BEFORE_POLLING = 2
        const val POLL_SCREEN_ON_MS = 2_000L
        const val POLL_SCREEN_OFF_MS = 30_000L
        const val PROJECT_TOKENS_MS = 30_000L
    }
}
