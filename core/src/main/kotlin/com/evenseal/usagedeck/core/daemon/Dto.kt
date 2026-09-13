package com.evenseal.usagedeck.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonTransformingSerializer

val DaemonJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
}

@Serializable
data class TokensCountsDto(
    val input: Long = 0,
    val output: Long = 0,
    val cacheCreate: Long = 0,
    val cacheRead: Long = 0,
    val messages: Long = 0,
    /** `summary.today` carries this; session/spend counts omit it and default to true. */
    val ready: Boolean = true
)

@Serializable
data class UserDto(
    val emailAddress: String? = null,
    val accountUuid: String? = null,
    val organizationUuid: String? = null,
    val displayName: String? = null
)

@Serializable
data class UpdateDto(
    val channel: String = "stable",
    val current: String = "",
    val available: String? = null,
    val state: String = "idle",
    val deferredReason: String? = null
)

@Serializable
data class HealthDto(
    val ok: Boolean = true,
    val version: String = "",
    val uptimeMs: Long = 0,
    val pid: Int = 0,
    val name: String? = null,
    val user: UserDto? = null,
    val update: UpdateDto? = null
)

@Serializable
data class LimitScopeDto(val model: String? = null, val surface: String? = null)

@Serializable
data class LimitDto(
    val id: String,
    val kind: String,
    val group: String = "",
    val percent: Int = 0,
    val severity: String = "normal",
    val resetsAt: String? = null,
    val scope: LimitScopeDto? = null,
    val isActive: Boolean = false
)

@Serializable
data class StatusDto(val byId: Map<String, String> = emptyMap(), val overall: String = "ok")

/**
 * The normalized limits body. It is the whole of `GET /v1/limits` and is nested under
 * `limits` in `GET /v1/summary`. `legacyWindows` and `extraUsage` are deliberately ignored.
 */
@Serializable
data class LimitsBodyDto(
    val limits: List<LimitDto> = emptyList(),
    val fetchedAt: String? = null,
    val stale: Boolean = false,
    val error: ErrorBodyDto? = null
)

@Serializable
data class ThresholdsDto(val warn: Int = 80, val critical: Int = 95)

@Serializable
data class SummaryDto(
    val limits: LimitsBodyDto = LimitsBodyDto(),
    val status: StatusDto = StatusDto(),
    val thresholds: ThresholdsDto = ThresholdsDto(),
    val today: TokensCountsDto = TokensCountsDto()
) {
    val fetchedAt: String? get() = limits.fetchedAt
    val stale: Boolean get() = limits.stale
}

/**
 * `session.project`. The daemon sends the rich `{ gitCommonDir, name }` form for hook-registered
 * sessions and, on some builds, the bare opaque projects-dir key as a string; both decode here.
 */
@Serializable
data class ProjectRefDto(val gitCommonDir: String? = null, val name: String = "", val key: String? = null)

object ProjectRefTolerant : JsonTransformingSerializer<ProjectRefDto>(ProjectRefDto.serializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement =
        if (element is JsonPrimitive) JsonObject(mapOf("key" to element)) else element
}

/** `snapshot.sessions` arrives either as `{ rev, sessions }` or as a bare array. */
object SessionsTolerant : JsonTransformingSerializer<SessionsDto>(SessionsDto.serializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement =
        if (element is JsonArray) JsonObject(mapOf("sessions" to element)) else element
}

@Serializable
data class PauseStateDto(
    val mode: String,
    val ruleId: String,
    val scope: String,
    val since: String,
    val frozenPids: List<Int> = emptyList()
)

@Serializable
data class LastToolDto(val name: String, val at: String)

@Serializable
data class SessionDto(
    val sessionId: String = "",
    /** Alias the daemon's event payloads use for [sessionId]. */
    val id: String? = null,
    val pid: Int? = null,
    val alive: Boolean = true,
    /** `active|paused|ended` on builds that send it; [alive] is derived from it when present. */
    val state: String? = null,
    val discovered: String = "hook",
    val cwd: String = "",
    val transcriptPath: String? = null,
    @Serializable(with = ProjectRefTolerant::class)
    val project: ProjectRefDto = ProjectRefDto(),
    val worktree: String? = null,
    val model: String? = null,
    val startedAt: String = "",
    val lastActivityAt: String = "",
    val tokens: TokensCountsDto = TokensCountsDto(),
    val pause: PauseStateDto? = null,
    val lastTool: LastToolDto? = null
) {
    /** [sessionId], or the `id` alias when that is what arrived. */
    val identifier: String get() = sessionId.ifBlank { id.orEmpty() }
}

@Serializable
data class SessionsDto(val rev: Long = 0, val sessions: List<SessionDto> = emptyList())

@Serializable
data class PauseRuleDto(
    val id: String,
    /** Either the full grammar (`session:<id>`) or the bare kind, with the id in [target]. */
    val scope: String,
    /** Present on builds that split the scope into kind + target. */
    val target: String? = null,
    val mode: String,
    val reason: String? = null,
    val createdAt: String,
    val createdBy: String = "",
    val expiresAt: String? = null
) {
    /** The scope in the daemon's `all | project:<key> | session:<id>` grammar. */
    val fullScope: String get() = if (scope.contains(':') || target == null) scope else "$scope:$target"
}

@Serializable
data class PauseResponseDto(val rule: PauseRuleDto, val affected: List<String> = emptyList())

@Serializable
data class ResumeResponseDto(val removed: List<String> = emptyList(), val resumed: List<String> = emptyList())

@Serializable
data class RulesDto(val rev: Long = 0, val rules: List<PauseRuleDto> = emptyList())

@Serializable
data class TokensGroupDto(
    val key: String,
    val label: String = "",
    val input: Long = 0,
    val output: Long = 0,
    val cacheCreate: Long = 0,
    val cacheRead: Long = 0,
    val messages: Long = 0
)

@Serializable
data class TokensDto(val ready: Boolean = true, val groups: List<TokensGroupDto> = emptyList())

@Serializable
data class ErrorBodyDto(val code: String, val message: String? = null, val hint: String? = null)

@Serializable
data class ErrorEnvelopeDto(val error: ErrorBodyDto)

@Serializable
data class PauseRequestDto(val scope: String, val mode: String, val reason: String)

@Serializable
data class ResumeRequestDto(val scope: String)
