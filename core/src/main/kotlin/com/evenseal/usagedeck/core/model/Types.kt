package com.evenseal.usagedeck.core.model

import java.time.Instant

/**
 * One paired daemon. A v1 pairing ([fp] null) talks plain HTTP to [addr]. A v2 pairing (daemon
 * §23.47) talks HTTPS pinned to [fp] for everything, on the TLS [port], and may fall back across
 * [addrs] — the address that redeemed the pairing code is [addr].
 */
data class MachineConfig(
    val id: String,
    val name: String,
    val addr: String,
    val port: Int,
    val token: String,
    /** Lowercase hex SHA-256 of the daemon certificate's SubjectPublicKeyInfo; null for v1. */
    val fp: String? = null,
    /** Every address from the pairing link, in the daemon's order. Empty for v1. */
    val addrs: List<String> = emptyList()
) {
    val baseUrl: String get() = baseUrlFor(addr)

    /** [addr] first, then the rest of [addrs] in the daemon's order. */
    val candidates: List<String> get() = (listOf(addr) + addrs).distinct()

    fun baseUrlFor(host: String): String = "${if (fp != null) "https" else "http"}://$host:$port"

    override fun toString(): String =
        "MachineConfig(id=$id, name=$name, addr=$addr, port=$port, token=<redacted>, fp=$fp, addrs=$addrs)"
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
    val transport: Transport = Transport.DISCONNECTED,
    /**
     * Set when the daemon stopped accepting this deck: its bearer token was rejected (401), or a
     * pinned machine presented a different certificate. Terminal until a re-pair or a slow probe
     * succeeds; the machine is shown dead with its sessions dropped and its pause controls off.
     */
    val needsRepair: RepairReason? = null
) {
    enum class Transport { SSE, POLLING, DISCONNECTED }
}

/** Why a machine needs re-pairing. [code] is the daemon error code; [message] is shown on the card. */
data class RepairReason(val code: String, val message: String)
