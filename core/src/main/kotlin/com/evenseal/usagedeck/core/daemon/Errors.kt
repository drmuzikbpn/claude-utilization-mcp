package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.RepairReason
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
            "gone" to "Session ended; pause cleared.",
            "pinning" to "This machine's certificate changed. Re-pair it with `claude-usage pair`.",
            "rate_limited" to "Too many attempts. Wait a minute and try again.",
            "bad_response" to "The machine sent a reply Usage Deck can't read.",
            "reply_lost" to "The Mac may have accepted the pairing code, but its reply was lost. " +
                "Run `claude-usage pair` again.",
            "internal" to "Pairing failed unexpectedly. Run `claude-usage pair` again."
        )
    }
}

/**
 * Whether this error means the machine no longer accepts this deck at all — retrying cannot fix
 * it, only a re-pair (or the old token coming back) can.
 */
fun DaemonException.repairReason(): RepairReason? = when (code) {
    "unauthorized" -> RepairReason(code, "It rejected this deck's token — it was probably rotated.")
    "pinning" -> RepairReason(code, "Its certificate changed, so this deck can no longer verify it.")
    else -> null
}

internal fun codeForStatus(status: Int): String = when (status) {
    401 -> "unauthorized"
    404 -> "not_found"
    409 -> "conflict"
    410 -> "gone"
    429 -> "rate_limited"
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
    if (PinnedTls.isPinMismatch(t)) return DaemonException("pinning", 0, null, null)
    if (t is IOException || t != null) return DaemonException("network", 0, t.message, null)
    return DaemonException("network", 0, null, null)
}
