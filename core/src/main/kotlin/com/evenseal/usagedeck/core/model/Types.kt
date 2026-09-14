package com.evenseal.usagedeck.core.model

import java.time.Instant

data class MachineConfig(
    val id: String,
    val name: String,
    val addr: String,
    val port: Int,
    val token: String
) {
    val baseUrl: String get() = "http://$addr:$port"
}

enum class Health { FRESH, STALE, DEAD }

data class User(
    val emailAddress: String?,
    val accountUuid: String?,
    val displayName: String?,
    /** Team-plan limits are per organisation, so one account in two orgs is two quotas. */
    val organizationUuid: String? = null,
    val organizationName: String? = null
)

enum class LimitStatus { OK, WARN, CRITICAL }

data class Limit(
    val id: String,
    val kind: String,
    val group: String,
    val percent: Int,
    val severity: String,
    val resetsAt: Instant?,
    val scopeModel: String?,
    val isActive: Boolean,
    val status: LimitStatus
)

data class Tokens(
    val input: Long = 0,
    val output: Long = 0,
    val cacheCreate: Long = 0,
    val cacheRead: Long = 0,
    val messages: Long = 0
) {
    val total: Long get() = input + output + cacheCreate + cacheRead

    operator fun plus(o: Tokens) = Tokens(
        input + o.input,
        output + o.output,
        cacheCreate + o.cacheCreate,
        cacheRead + o.cacheRead,
        messages + o.messages
    )

    companion object {
        val ZERO = Tokens()
    }
}

enum class PauseMode { SOFT, HARD }

data class PauseState(
    val mode: PauseMode,
    val ruleId: String,
    val scope: String,
    val since: Instant,
    /** Stopped tool subprocesses (daemon §23.16). Empty under a hard rule means "held at the gate", not a failure. */
    val frozenPids: List<Int>,
    /** 0 under soft; 1 frozen once; 2+ frozen again under the same standing rule (re-registered or daemon restart). */
    val freezes: Int = 0
)

data class LastTool(val name: String, val at: Instant)

enum class Discovered { HOOK, TRANSCRIPT }

data class Session(
    val sessionId: String,
    val pid: Int?,
    val alive: Boolean,
    val discovered: Discovered,
    val cwd: String,
    val transcriptPath: String?,
    val projectKey: String,
    val projectName: String,
    val worktree: String?,
    val model: String?,
    val startedAt: Instant,
    val lastActivityAt: Instant,
    val tokens: Tokens,
    val pause: PauseState?,
    val lastTool: LastTool?,
    /** The `/rename` title Claude Code stores next to the transcript; null when never renamed. */
    val title: String? = null
) {
    val canHardPause: Boolean get() = discovered == Discovered.HOOK && pid != null
}

data class PauseRule(
    val id: String,
    val scope: String,
    val mode: PauseMode,
    val reason: String?,
    val createdAt: Instant,
    val createdBy: String
)

data class UpdateState(
    val channel: String,
    val current: String,
    val available: String?,
    val state: String,
    val deferredReason: String?
)

data class ProjectTokens(val key: String, val label: String, val tokens: Tokens)

data class MachineState(
    val config: MachineConfig,
    val health: Health = Health.DEAD,
    val lastHeartbeatAt: Instant? = null,
    val name: String? = null,
    val version: String? = null,
    val user: User? = null,
    val limits: List<Limit> = emptyList(),
    val limitsFetchedAt: Instant? = null,
    val today: Tokens = Tokens.ZERO,
    val sessions: List<Session> = emptyList(),
    val rules: List<PauseRule> = emptyList(),
    val update: UpdateState? = null,
    val projectTokens: List<ProjectTokens> = emptyList(),
    val rev: Long = 0,
    val lastError: String? = null,
    val transport: Transport = Transport.DISCONNECTED
) {
    enum class Transport { SSE, POLLING, DISCONNECTED }
}
