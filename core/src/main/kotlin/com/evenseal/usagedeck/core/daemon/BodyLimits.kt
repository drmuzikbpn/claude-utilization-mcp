// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.daemon

import java.io.IOException
import okhttp3.Interceptor
import okhttp3.Response
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.ForwardingSource
import okio.Source
import okio.buffer

/** A reply or stream exceeded [BodyLimits]: the peer is broken or hostile, never merely slow. */
class BodyTooLargeException(what: String, limit: Long) : IOException("$what is larger than $limit bytes")

/**
 * How much the deck will read from a daemon. A paired daemon is trusted with the dashboard, not
 * with the phone's memory: everything it sends is read through one of these caps, so a broken or
 * impersonated one cannot run a 2 GB kiosk out of heap.
 */
object BodyLimits {
    /** Any REST reply. A busy machine's `/v1/sessions` is a few hundred kilobytes. */
    const val REST_BYTES = 4L * 1024 * 1024

    /** An error envelope: three short strings. */
    const val ERROR_BYTES = 64L * 1024

    /** The `/v1/pair` reply: a token, a name and a fingerprint. */
    const val PAIR_BYTES = 64L * 1024

    /** One line of the event stream; a `snapshot` is a single `data:` line. */
    const val SSE_LINE_BYTES = 4L * 1024 * 1024

    /** One whole event, across all of its lines. */
    const val SSE_EVENT_BYTES = 8L * 1024 * 1024

    /** The body as text, or [BodyTooLargeException] once it passes [limit] — never more than that is buffered. */
    fun text(response: Response, limit: Long, what: String = "reply"): String {
        val body = response.body
        val source = body.source()
        if (source.request(limit + 1)) throw BodyTooLargeException(what, limit)
        return source.readString(body.contentType()?.charset(Charsets.UTF_8) ?: Charsets.UTF_8)
    }

    /** Like [text], for a body nobody depends on (an error envelope): unreadable or oversized is `null`. */
    fun textOrNull(response: Response, limit: Long): String? = try {
        text(response, limit)
    } catch (e: IOException) {
        null
    }

    /**
     * Fails an event stream whose line or event outgrows its cap. okhttp-sse reads a line with no
     * bound of its own, so the guard sits underneath it, on the bytes.
     */
    val sseGuard = Interceptor { chain ->
        val response = chain.proceed(chain.request())
        val body = response.body
        val guarded = SseGuardSource(body.source()).buffer().asResponseBody(body.contentType(), body.contentLength())
        response.newBuilder().body(guarded).build()
    }
}

private class SseGuardSource(delegate: Source) : ForwardingSource(delegate) {
    private var lineBytes = 0L
    private var eventBytes = 0L
    private val scratch = Buffer()

    override fun read(sink: Buffer, byteCount: Long): Long {
        val before = sink.size
        val read = super.read(sink, byteCount)
        if (read <= 0) return read
        sink.copyTo(scratch, before, read)
        while (!scratch.exhausted()) {
            when (scratch.readByte().toInt()) {
                NEWLINE -> {
                    // A blank line ends the event.
                    if (lineBytes == 0L) eventBytes = 0 else eventBytes++
                    lineBytes = 0
                }
                CARRIAGE_RETURN -> Unit
                else -> {
                    lineBytes++
                    eventBytes++
                }
            }
            if (lineBytes > BodyLimits.SSE_LINE_BYTES) {
                throw BodyTooLargeException("event stream line", BodyLimits.SSE_LINE_BYTES)
            }
            if (eventBytes > BodyLimits.SSE_EVENT_BYTES) {
                throw BodyTooLargeException("event", BodyLimits.SSE_EVENT_BYTES)
            }
        }
        return read
    }

    private companion object {
        const val NEWLINE = '\n'.code
        const val CARRIAGE_RETURN = '\r'.code
    }
}
