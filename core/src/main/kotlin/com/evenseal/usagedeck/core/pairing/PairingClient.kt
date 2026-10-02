package com.evenseal.usagedeck.core.pairing

import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.daemon.DaemonJson
import com.evenseal.usagedeck.core.daemon.Endpoints
import com.evenseal.usagedeck.core.daemon.PinnedTls
import com.evenseal.usagedeck.core.daemon.daemonExceptionOf
import com.evenseal.usagedeck.core.model.MachineConfig
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Redeems a [PairingInvite] for the daemon's bearer: `POST /v1/pair {"code"}` over HTTPS pinned
 * to the invite's fingerprint, trying each address in the link's order until one answers. It is
 * the one daemon endpoint that takes no bearer. Neither the code nor the token is ever logged.
 */
class PairingClient(client: OkHttpClient) {
    private val client: OkHttpClient = client.newBuilder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .callTimeout(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * The paired machine, addressed by whichever address answered. Throws [DaemonException]:
     * `unauthorized` (code invalid or expired), `rate_limited`, `pinning` (wrong certificate, or a
     * reply naming another key), `bad_response`, or `network` when no address answered.
     */
    suspend fun redeem(invite: PairingInvite, id: String = UUID.randomUUID().toString()): MachineConfig =
        withContext(Dispatchers.IO) {
            val pinned = PinnedTls.client(client, invite.fp)
            val body = DaemonJson.encodeToString(PairRequestDto(invite.code)).toRequestBody(JSON_MEDIA)
            var winner = invite.addrs.first()
            val reply = Endpoints(invite.addrs).first { addr ->
                val url = HttpUrl.Builder().scheme("https").host(addr).port(invite.port).encodedPath("/v1/pair").build()
                val request = Request.Builder().url(url).header("Accept", "application/json").post(body).build()
                pinned.newCall(request).execute().use { response ->
                    val text = runCatching { response.body?.string() }.getOrNull()
                    if (!response.isSuccessful) throw daemonExceptionOf(response.code, text)
                    val dto = runCatching { DaemonJson.decodeFromString(PairResponseDto.serializer(), text.orEmpty()) }
                        .getOrNull()
                    if (dto == null || dto.token.isBlank()) {
                        throw DaemonException(
                            "bad_response",
                            response.code,
                            null,
                            null
                        )
                    }
                    winner = addr
                    dto
                }
            }
            // Belt and braces: the TLS pin already proved the key, so a reply naming another is a bug.
            if (reply.fp != null && !reply.fp.equals(invite.fp, ignoreCase = true)) {
                throw DaemonException("pinning", 0, null, null)
            }
            MachineConfig(
                id = id,
                name = reply.name?.takeIf { it.isNotBlank() } ?: invite.name,
                addr = winner,
                port = invite.port,
                token = reply.token,
                fp = invite.fp,
                addrs = invite.addrs
            )
        }

    @Serializable
    private data class PairRequestDto(val code: String)

    @Serializable
    private data class PairResponseDto(val token: String = "", val name: String? = null, val fp: String? = null) {
        override fun toString(): String = "PairResponseDto(token=<redacted>, name=$name, fp=$fp)"
    }

    private companion object {
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        const val CONNECT_TIMEOUT_SECONDS = 2L
        const val READ_TIMEOUT_SECONDS = 5L
        const val CALL_TIMEOUT_SECONDS = 6L
    }
}
