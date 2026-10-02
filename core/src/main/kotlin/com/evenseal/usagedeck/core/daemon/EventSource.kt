package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.MachineConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

sealed interface Connection {
    object Open : Connection

    data class Closed(val error: DaemonException?) : Connection
}

/**
 * Wraps the daemon's `GET /v1/events` SSE stream.
 *
 * Each collection opens one connection and emits [Connection.Open], then [DaemonEvent]s, then
 * exactly one [Connection.Closed] before completing. Reconnection is the caller's job.
 *
 * A pinned machine (`config.fp`) streams over HTTPS with [PinnedTls]. Each connection dials
 * [Endpoints.current]; one that never opens moves the next connection on to the following
 * address, and one that opens makes its address the preferred one for REST as well.
 */
class DaemonEventSource(
    private val config: MachineConfig,
    client: OkHttpClient,
    private val endpoints: Endpoints = Endpoints(config.candidates)
) {
    private val client: OkHttpClient = client.newBuilder()
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()
        .let { if (config.fp != null) PinnedTls.client(it, config.fp) else it }

    /** Elements are either a [DaemonEvent] or a [Connection]. */
    fun events(): Flow<Any> = callbackFlow {
        val addr = endpoints.current()
        val request = Request.Builder()
            .url(config.baseUrlFor(addr) + "/v1/events")
            .header("Authorization", "Bearer ${config.token}")
            .header("Accept", "text/event-stream")
            .get()
            .build()

        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                endpoints.succeeded(addr)
                trySend(Connection.Open)
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                trySend(SseParser.parse(type, data))
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                // No response at all means this address could not be reached (or failed the pin).
                if (response == null) endpoints.failed(addr)
                trySend(Connection.Closed(toDaemonException(t, response)))
                close()
            }

            override fun onClosed(eventSource: EventSource) {
                trySend(Connection.Closed(null))
                close()
            }
        }

        val source = EventSources.createFactory(client).newEventSource(request, listener)
        awaitClose { source.cancel() }
    }

    private companion object {
        const val CONNECT_TIMEOUT_SECONDS = 3L
    }
}
