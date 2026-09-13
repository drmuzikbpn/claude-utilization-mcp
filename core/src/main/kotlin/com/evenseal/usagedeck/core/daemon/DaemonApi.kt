package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.PauseMode
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

sealed interface SessionsResult {
    data class Changed(val dto: SessionsDto, val etag: String?) : SessionsResult

    object Unchanged : SessionsResult
}

interface DaemonApi {
    suspend fun health(): HealthDto

    suspend fun summary(): SummaryDto

    suspend fun sessions(ifNoneMatch: String?): SessionsResult

    suspend fun tokensByProjectToday(): TokensDto

    suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto

    suspend fun resume(scope: String): ResumeResponseDto

    suspend fun rules(): RulesDto
}

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

class OkHttpDaemonApi(
    private val config: MachineConfig,
    client: OkHttpClient
) : DaemonApi {
    private val client: OkHttpClient = client.newBuilder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .callTimeout(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private fun builder(path: String): Request.Builder = Request.Builder()
        .url(config.baseUrl + path)
        .header("Authorization", "Bearer ${config.token}")
        .header("Accept", "application/json")

    private suspend fun <T> call(request: Request, parse: (Response, String) -> T): T = withContext(Dispatchers.IO) {
        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw DaemonException("network", 0, e.message, null)
        }
        response.use { r ->
            val body = runCatching { r.body?.string() }.getOrNull()
            if (r.code == NOT_MODIFIED || r.isSuccessful) {
                parse(r, body.orEmpty())
            } else {
                throw daemonExceptionOf(r.code, body)
            }
        }
    }

    override suspend fun health(): HealthDto =
        call(builder("/health").get().build()) { _, body -> DaemonJson.decodeFromString(body) }

    override suspend fun summary(): SummaryDto =
        call(builder("/v1/summary").get().build()) { _, body -> DaemonJson.decodeFromString(body) }

    override suspend fun sessions(ifNoneMatch: String?): SessionsResult {
        val request = builder("/v1/sessions")
            .apply { if (ifNoneMatch != null) header("If-None-Match", ifNoneMatch) }
            .get()
            .build()
        return call(request) { response, body ->
            if (response.code == NOT_MODIFIED) {
                SessionsResult.Unchanged
            } else {
                SessionsResult.Changed(DaemonJson.decodeFromString(body), response.header("ETag"))
            }
        }
    }

    override suspend fun tokensByProjectToday(): TokensDto =
        call(builder("/v1/tokens?since=today&groupBy=project").get().build()) { _, body ->
            DaemonJson.decodeFromString(body)
        }

    override suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto {
        val payload = DaemonJson.encodeToString(
            PauseRequestDto(scope, if (mode == PauseMode.HARD) "hard" else "soft", reason)
        )
        val request = builder("/v1/pause").post(payload.toRequestBody(JSON_MEDIA)).build()
        return call(request) { _, body -> DaemonJson.decodeFromString(body) }
    }

    override suspend fun resume(scope: String): ResumeResponseDto {
        val payload = DaemonJson.encodeToString(ResumeRequestDto(scope))
        val request = builder("/v1/resume").post(payload.toRequestBody(JSON_MEDIA)).build()
        return call(request) { _, body -> DaemonJson.decodeFromString(body) }
    }

    override suspend fun rules(): RulesDto =
        call(builder("/v1/pause/rules").get().build()) { _, body -> DaemonJson.decodeFromString(body) }

    private companion object {
        const val NOT_MODIFIED = 304
        const val CONNECT_TIMEOUT_SECONDS = 2L
        const val READ_TIMEOUT_SECONDS = 5L
        const val CALL_TIMEOUT_SECONDS = 6L
    }
}
