package com.evenseal.usagedeck.core.model

import java.time.Duration
import java.time.Instant

/**
 * Per-key ring buffers of (timestamp, cumulative tokens) used to derive burn rates.
 *
 * Keys are opaque (`"<machineId>/s/<sessionId>"`, `"<machineId>/p/<projectKey>"`,
 * `"<machineId>/m"`). A cumulative counter that goes backwards means the underlying thing
 * restarted, so the key's history is discarded and the new sample becomes the baseline —
 * never a negative rate.
 *
 * Samples arrive on the SSE thread while Compose reads rates on the main thread, so every
 * method takes the same lock; a reader works on a snapshot of the key's points.
 */
class BurnHistory(
    private val retention: Duration = Duration.ofHours(5),
    private val maxPoints: Int = 2000
) {
    data class Point(val at: Instant, val cumulative: Long)

    private val points = LinkedHashMap<String, ArrayDeque<Point>>()

    fun record(key: String, at: Instant, cumulative: Long) = synchronized(points) {
        val deque = points.getOrPut(key) { ArrayDeque() }
        val last = deque.lastOrNull()
        if (last != null && cumulative < last.cumulative) {
            deque.clear()
        }
        deque.addLast(Point(at, cumulative))
        val cutoff = at.minus(retention)
        while (deque.isNotEmpty() && deque.first().at.isBefore(cutoff)) {
            deque.removeFirst()
        }
        while (deque.size > maxPoints) {
            deque.removeFirst()
        }
    }

    fun ratePerMinute(key: String, now: Instant, window: Duration = Duration.ofSeconds(60)): Double {
        val deque = snapshot(key) ?: return 0.0
        val from = now.minus(window)
        val inWindow = deque.filter { !it.at.isBefore(from) && !it.at.isAfter(now) }
        if (inWindow.size < 2) return 0.0
        val first = inWindow.first()
        val last = inWindow.last()
        val seconds = Duration.between(first.at, last.at).seconds
        if (seconds <= 0L) return 0.0
        return (last.cumulative - first.cumulative).toDouble() / seconds * SECONDS_PER_MINUTE
    }

    /** Tokens/min per bucket over [window] ending at [now], oldest first; `0.0` where nothing is known. */
    fun series(key: String, now: Instant, window: Duration, buckets: Int): List<Double> {
        if (buckets <= 0) return emptyList()
        val deque = snapshot(key) ?: return List(buckets) { 0.0 }
        val bucketSeconds = window.seconds.toDouble() / buckets
        if (bucketSeconds <= 0.0) return List(buckets) { 0.0 }
        val start = now.minus(window)
        return (0 until buckets).map { i ->
            val bucketStart = start.plusMillis((i * bucketSeconds * MILLIS_PER_SECOND).toLong())
            val bucketEnd = start.plusMillis(((i + 1) * bucketSeconds * MILLIS_PER_SECOND).toLong())
            val from = deque.lastOrNull { !it.at.isAfter(bucketStart) }
            val to = deque.lastOrNull { !it.at.isAfter(bucketEnd) }
            if (from == null || to == null || to.cumulative <= from.cumulative) {
                0.0
            } else {
                (to.cumulative - from.cumulative).toDouble() / bucketSeconds * SECONDS_PER_MINUTE
            }
        }
    }

    fun forget(key: String) {
        synchronized(points) { points.remove(key) }
    }

    private fun snapshot(key: String): List<Point>? = synchronized(points) { points[key]?.toList() }

    private companion object {
        const val SECONDS_PER_MINUTE = 60.0
        const val MILLIS_PER_SECOND = 1000.0
    }
}
