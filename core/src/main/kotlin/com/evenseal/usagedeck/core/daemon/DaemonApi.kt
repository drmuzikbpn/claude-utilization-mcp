package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.PauseMode
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLHandshakeException
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

/**
 * REST against one daemon. A pinned machine (`config.fp`) talks HTTPS with [PinnedTls] and tries
 * each of its addresses via [endpoints]; a v1 machine has one address and plain HTTP.
 */
class OkHttpDaemonApi(
    private val config: MachineConfig,
    client: OkHttpClient,
    private val endpoints: Endpoints = Endpoints(config.candidates)
) : DaemonApi {
    private val client: OkHttpClient = client.newBuilder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .callTimeout(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()
        .let { if (config.fp != null) PinnedTls.client(it, config.fp) else it }

    /** One request, built per candidate address. */
    private class Call(
        val path: String,
        val configure: Request.Builder.() -> Unit = { get() },
        val idempotent: Boolean = true
    )

    private suspend fun <T> call(spec: Call, parse: (Response, String) -> T): T = withContext(Dispatchers.IO) {
        // A GET may be retried anywhere; a POST only when it provably never left this phone.
        endpoints.first(retryable = { spec.idempotent || neverSent(it) }) { addr ->
            val request = Request.Builder()
                .url(config.baseUrlFor(addr) + spec.path)
                .header("Authorization", "Bearer ${config.token}")
                .header("Accept", "application/json")
                .apply(spec.configure)
                .build()
            client.newCall(request).execute().use { r ->
                val body = runCatching { r.body?.string() }.getOrNull()
                if (r.code == NOT_MODIFIED || r.isSuccessful) {
                    parse(r, body.orEmpty())
                } else {
                    throw daemonExceptionOf(r.code, body)
                }
            }
        }
    }

    private fun neverSent(e: IOException): Boolean = e is ConnectException ||
        e is UnknownHostException ||
        e is NoRouteToHostException ||
        e is SSLHandshakeException ||
        PinnedTls.isPinMismatch(e) ||
        (e is SocketTimeoutException && e.message.orEmpty().contains("connect", ignoreCase = true))

    override suspend fun health(): HealthDto = call(Call("/health")) { _, body -> DaemonJson.decodeFromString(body) }

    override suspend fun summary(): SummaryDto =
        call(Call("/v1/summary")) { _, body -> DaemonJson.decodeFromString(body) }

    override suspend fun sessions(ifNoneMatch: String?): SessionsResult {
        val request = Call("/v1/sessions", { if (ifNoneMatch != null) header("If-None-Match", ifNoneMatch) })
        return call(request) { response, body ->
            if (response.code == NOT_MODIFIED) {
                SessionsResult.Unchanged
            } else {
                SessionsResult.Changed(DaemonJson.decodeFromString(body), response.header("ETag"))
            }
        }
    }

    override suspend fun tokensByProjectToday(): TokensDto =
        call(Call("/v1/tokens?since=today&groupBy=project")) { _, body ->
            DaemonJson.decodeFromString(body)
        }

    override suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto {
        val payload = DaemonJson.encodeToString(
            PauseRequestDto(scope, if (mode == PauseMode.HARD) "hard" else "soft", reason)
        )
        val request = Call("/v1/pause", { post(payload.toRequestBody(JSON_MEDIA)) }, idempotent = false)
        return call(request) { _, body -> DaemonJson.decodeFromString(body) }
    }

    override suspend fun resume(scope: String): ResumeResponseDto {
        val payload = DaemonJson.encodeToString(ResumeRequestDto(scope))
        val request = Call("/v1/resume", { post(payload.toRequestBody(JSON_MEDIA)) }, idempotent = false)
        return call(request) { _, body -> DaemonJson.decodeFromString(body) }
    }

    override suspend fun rules(): RulesDto =
        call(Call("/v1/pause/rules")) { _, body -> DaemonJson.decodeFromString(body) }

    private companion object {
        const val NOT_MODIFIED = 304
        const val CONNECT_TIMEOUT_SECONDS = 2L
        const val READ_TIMEOUT_SECONDS = 5L
        const val CALL_TIMEOUT_SECONDS = 6L
    }
}
