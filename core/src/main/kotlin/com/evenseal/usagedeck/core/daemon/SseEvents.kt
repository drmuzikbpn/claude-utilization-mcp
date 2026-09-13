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
        val today: TokensCountsDto,
        val sessions: List<SessionDto>,
        val rules: List<PauseRuleDto>,
        val update: UpdateDto?,
        val rev: Long
    ) : DaemonEvent

    data class Limits(val limits: List<LimitDto>, val status: StatusDto) : DaemonEvent

    data class Spend(val today: TokensCountsDto, val delta: TokensCountsDto) : DaemonEvent

    /** [type] is one of `start`, `end`, `update`. */
    data class SessionChange(val type: String, val session: SessionDto) : DaemonEvent

    data class Pause(val rules: List<PauseRuleDto>, val affected: List<String>) : DaemonEvent

    data class Update(val update: UpdateDto) : DaemonEvent

    object Heartbeat : DaemonEvent

    data class Unknown(val event: String) : DaemonEvent
}

@Serializable
internal data class SnapshotDto(
    val name: String? = null,
    val version: String? = null,
    val user: UserDto? = null,
    val summary: SummaryDto = SummaryDto(),
    val sessions: SessionsDto = SessionsDto(),
    val rules: JsonElement? = null,
    val update: UpdateDto? = null,
    val rev: Long = 0
)

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
        if (name == "heartbeat") return DaemonEvent.Heartbeat
        return runCatching {
            when (name) {
                "snapshot" -> snapshot(DaemonJson.decodeFromString<SnapshotDto>(data))
                "limits" -> DaemonJson.decodeFromString<SummaryDto>(data)
                    .let { DaemonEvent.Limits(it.limits, it.status) }
                "spend" -> DaemonJson.decodeFromString<SpendEventDto>(data)
                    .let { DaemonEvent.Spend(it.today, it.delta) }
                "session" -> DaemonJson.decodeFromString<SessionEventDto>(data)
                    .let { DaemonEvent.SessionChange(it.type, it.session) }
                "pause" -> DaemonJson.decodeFromString<PauseEventDto>(data)
                    .let { DaemonEvent.Pause(it.rules, it.affected) }
                "update" -> DaemonEvent.Update(DaemonJson.decodeFromString<UpdateDto>(data))
                else -> DaemonEvent.Unknown(name)
            }
        }.getOrElse { DaemonEvent.Unknown(name) }
    }

    private fun snapshot(dto: SnapshotDto) = DaemonEvent.Snapshot(
        name = dto.name,
        version = dto.version,
        user = dto.user,
        limits = dto.summary.limits,
        status = dto.summary.status,
        today = dto.summary.today,
        sessions = dto.sessions.sessions,
        rules = rulesOf(dto.rules),
        update = dto.update,
        rev = dto.rev
    )

    /** The daemon sends `rules` either as a bare array or wrapped in `{ rev, rules }`. */
    private fun rulesOf(element: JsonElement?): List<PauseRuleDto> = when (element) {
        null -> emptyList()
        is JsonArray -> DaemonJson.decodeFromJsonElement(ListSerializer(PauseRuleDto.serializer()), element)
        is JsonObject -> DaemonJson.decodeFromJsonElement(RulesDto.serializer(), element).rules
        else -> emptyList()
    }
}
