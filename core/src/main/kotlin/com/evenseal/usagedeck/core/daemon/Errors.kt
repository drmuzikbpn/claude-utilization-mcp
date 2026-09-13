package com.evenseal.usagedeck.core.daemon

import java.io.IOException
import kotlinx.serialization.decodeFromString
import okhttp3.Response

class DaemonException(
    val code: String,
    val httpStatus: Int,
    message: String?,
    val hint: String?
) : Exception(message) {
    fun userMessage(): String = hint ?: message ?: DEFAULTS[code] ?: "Daemon error ($code)"

    companion object {
        val DEFAULTS = mapOf(
            "unauthorized" to "Token rejected. Re-run pairing on the Mac.",
            "network" to "Machine unreachable.",
            "not_found" to "Session no longer exists.",
            "conflict" to "That session can't be hard-paused (no trusted pid).",
            "gone" to "Session ended; pause cleared."
        )
    }
}

internal fun codeForStatus(status: Int): String = when (status) {
    401 -> "unauthorized"
    404 -> "not_found"
    409 -> "conflict"
    410 -> "gone"
    else -> "http_$status"
}

/** Builds a [DaemonException] from a non-2xx response, preferring the daemon's error envelope. */
internal fun daemonExceptionOf(status: Int, body: String?): DaemonException {
    val envelope = body
        ?.takeIf { it.isNotBlank() }
        ?.let { runCatching { DaemonJson.decodeFromString<ErrorEnvelopeDto>(it).error }.getOrNull() }
    return if (envelope != null) {
        DaemonException(envelope.code, status, envelope.message, envelope.hint)
    } else {
        DaemonException(codeForStatus(status), status, null, null)
    }
}

/** Maps an SSE/HTTP failure (throwable and/or response) onto a [DaemonException]. */
internal fun toDaemonException(t: Throwable?, response: Response?): DaemonException {
    if (response != null && !response.isSuccessful) {
        val body = runCatching { response.body?.string() }.getOrNull()
        return daemonExceptionOf(response.code, body)
    }
    if (t is DaemonException) return t
    if (t is IOException || t != null) return DaemonException("network", 0, t.message, null)
    return DaemonException("network", 0, null, null)
}
