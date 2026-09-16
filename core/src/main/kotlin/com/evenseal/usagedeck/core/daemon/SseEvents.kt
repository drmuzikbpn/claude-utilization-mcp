package com.evenseal.usagedeck.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

sealed interface DaemonEvent {
    data class Snapshot(
        val name: String?,
        val version: String?,
        val user: UserDto?,
        val limits: List<LimitDto>,
        val status: StatusDto,
        val thresholds: ThresholdsDto,
        val today: TokensCountsDto,
        val sessions: List<SessionDto>,
        val rules: List<PauseRuleDto>,
        val update: UpdateDto?,
        val rev: Long,
        /** When the *daemon* last read the account's usage, not when this phone received it. */
        val fetchedAt: String?
    ) : DaemonEvent

    /**
     * The `/v1/limits` body minus `raw`. It carries no status map — the client keeps the last
     * one it saw from a `snapshot` and falls back to thresholds for ids it has never seen.
     */
    data class Limits(val limits: List<LimitDto>, val fetchedAt: String?, val stale: Boolean) : DaemonEvent

    /**
     * Machine-wide spend. [today] is cumulative and authoritative; [delta] is **per-event** — the
     * sum of the increments inside the daemon's 1 s coalesce window, not a running total. Burn
     * rates are derived from [today], never from [delta].
     */
    data class Spend(val today: TokensCountsDto, val delta: TokensCountsDto) : DaemonEvent

    /** [type] is one of `start`, `end`, `update`. */
    data class SessionChange(val type: String, val session: SessionDto) : DaemonEvent

    data class Pause(val rules: List<PauseRuleDto>, val affected: List<String>) : DaemonEvent

    data class Update(val update: UpdateDto) : DaemonEvent

    /** `{ rev, at }`. Both are advisory; the client ages machines off its own clock. */
    data class Heartbeat(val rev: Long = 0, val at: String? = null) : DaemonEvent

    data class Unknown(val event: String) : DaemonEvent
}

/**
 * `snapshot` payload. `summary` is byte-for-byte the `/v1/summary` body, `limits` the
 * `/v1/limits` body minus `raw`, and `sessions` the §17.3 session objects as a bare array.
 */
@Serializable
internal data class SnapshotDto(
    val name: String? = null,
    val version: String? = null,
    val user: UserDto? = null,
    val summary: SummaryDto = SummaryDto(),
    val limits: LimitsBodyDto = LimitsBodyDto(),
    val sessions: List<SessionDto> = emptyList(),
    /** Either the `/v1/pause/rules` body or a bare array of rules; both are accepted. */
    val rules: JsonElement? = null,
    val update: UpdateDto? = null,
    val rev: Long = 0
)

@Serializable
internal data class HeartbeatDto(val rev: Long = 0, val at: String? = null)

@Serializable
internal data class SpendEventDto(
    val today: TokensCountsDto = TokensCountsDto(),
    val delta: TokensCountsDto = TokensCountsDto()
)

@Serializable
internal data class SessionEventDto(val type: String = "update", val session: SessionDto)

@Serializable
internal data class PauseEventDto(
    val rules: List<PauseRuleDto> = emptyList(),
    val affected: List<String> = emptyList()
)

/** Parses a raw `(event, data)` SSE pair. Never throws; malformed payloads become [DaemonEvent.Unknown]. */
object SseParser {
    fun parse(event: String?, data: String): DaemonEvent {
        val name = event ?: ""
        return runCatching {
            when (name) {
                "heartbeat" -> if (data.isBlank()) {
                    DaemonEvent.Heartbeat()
                } else {
                    DaemonJson.decodeFromString<HeartbeatDto>(data).let { DaemonEvent.Heartbeat(it.rev, it.at) }
                }
                "snapshot" -> snapshot(DaemonJson.decodeFromString<SnapshotDto>(data))
                "limits" -> DaemonJson.decodeFromString<LimitsBodyDto>(data)
                    .let { DaemonEvent.Limits(it.limits, it.fetchedAt, it.stale) }
                "spend" -> DaemonJson.decodeFromString<SpendEventDto>(data)
                    .let { DaemonEvent.Spend(it.today, it.delta) }
                "session" -> DaemonJson.decodeFromString<SessionEventDto>(data)
                    .let { DaemonEvent.SessionChange(it.type, it.session) }
                "pause" -> DaemonJson.decodeFromString<PauseEventDto>(data)
                    .let { DaemonEvent.Pause(it.rules, it.affected) }
                "update" -> DaemonEvent.Update(DaemonJson.decodeFromString<UpdateDto>(data))
                else -> DaemonEvent.Unknown(name)
            }
        }.getOrElse { if (name == "heartbeat") DaemonEvent.Heartbeat() else DaemonEvent.Unknown(name) }
    }

    private fun snapshot(dto: SnapshotDto) = DaemonEvent.Snapshot(
        name = dto.name,
        version = dto.version,
        user = dto.user,
        limits = dto.summary.limits.limits.ifEmpty { dto.limits.limits },
        status = dto.summary.status,
        thresholds = dto.summary.thresholds,
        today = dto.summary.today,
        sessions = dto.sessions,
        rules = rulesOf(dto.rules),
        update = dto.update,
        rev = dto.rev,
        fetchedAt = dto.summary.fetchedAt ?: dto.limits.fetchedAt
    )

    private fun rulesOf(element: JsonElement?): List<PauseRuleDto> = when (element) {
        is JsonArray -> DaemonJson.decodeFromJsonElement(ListSerializer(PauseRuleDto.serializer()), element)
        is JsonObject -> DaemonJson.decodeFromJsonElement(RulesDto.serializer(), element).rules
        else -> emptyList()
    }
}
