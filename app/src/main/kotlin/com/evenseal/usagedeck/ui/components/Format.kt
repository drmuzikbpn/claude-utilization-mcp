package com.evenseal.usagedeck.ui.components

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToLong

/**
 * Every number the deck renders goes through here, so the dock reads the same in every screen.
 * All output is deliberately short: the Nexus 5X is read from across a room.
 */
object Format {
    private val HOUR_MINUTE: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)
    private val DAY_HOUR_MINUTE: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE HH:mm", Locale.UK)

    /** `0`, `999`, `4.2k`, `1.2M`, `12.4M` — a trailing `.0` is always dropped. */
    fun tokens(n: Long): String = compact(n)

    /** `0/min`, `412/min`, `38k/min`. */
    fun ratePerMin(r: Double): String = compact(r.roundToLong()) + "/min"

    /**
     * `resets: unknown` when the daemon did not give one, `resets 16:35 · 2h33` inside a day and
     * `resets Thu 09:00` beyond it.
     */
    fun resets(at: Instant?, now: Instant, zone: ZoneId): String {
        if (at == null) return "resets: unknown"
        val local = at.atZone(zone)
        val remaining = Duration.between(now, at)
        if (remaining >= Duration.ofHours(24)) {
            return "resets ${DAY_HOUR_MINUTE.format(local)}"
        }
        return "resets ${HOUR_MINUTE.format(local)} · ${span(remaining)}"
    }

    /** The caption form for a bar row: `2h33 left` inside a day, `Thu 09:00` beyond it, `unknown` without one. */
    fun resetsShort(at: Instant?, now: Instant, zone: ZoneId): String {
        if (at == null) return "unknown"
        val remaining = Duration.between(now, at)
        if (remaining >= Duration.ofHours(24)) return DAY_HOUR_MINUTE.format(at.atZone(zone))
        return "${span(remaining)} left"
    }

    /** `claude-opus-5` → `opus`, `claude-fable-5-1` → `fable`, `claude-haiku-4-5-20251001` → `haiku`; unknown ids pass through. */
    fun modelShort(model: String?): String? {
        if (model == null) return null
        val family = model.removePrefix("claude-").substringBefore('-')
        return family.ifBlank { model }
    }

    /** `macbook-pro-10.tail42c6d2.ts.net` → `macbook-pro-10`; a plain hostname is unchanged. */
    fun hostShort(name: String): String = name.substringBefore('.')

    /** `0:42`, `12:05`; a deadline already gone reads `0:00`. */
    fun countdown(until: Instant, now: Instant): String {
        val seconds = Duration.between(now, until).seconds.coerceAtLeast(0)
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }

    /** The first four characters of a session id, which is enough to tell rows apart. */
    fun shortId(sessionId: String) = sessionId.take(4) + "…"

    /** `4s ago`, `3m ago`, `2h ago`, `3d ago`; `never` when there is nothing to age. */
    fun age(since: Instant?, now: Instant): String {
        if (since == null) return "never"
        val seconds = Duration.between(since, now).seconds.coerceAtLeast(0)
        return when {
            seconds < 60 -> "${seconds}s ago"
            seconds < 3_600 -> "${seconds / 60}m ago"
            seconds < 86_400 -> "${seconds / 3_600}h ago"
            else -> "${seconds / 86_400}d ago"
        }
    }

    /** `2h33` for a span with hours in it, `7m` below the hour, clamped at `0m`. */
    private fun span(remaining: Duration): String {
        val seconds = remaining.seconds.coerceAtLeast(0)
        val hours = seconds / 3_600
        val minutes = (seconds % 3_600) / 60
        return if (hours > 0) "${hours}h${minutes.toString().padStart(2, '0')}" else "${minutes}m"
    }

    private fun compact(n: Long): String {
        val value = n.coerceAtLeast(0)
        if (value < 1_000) return value.toString()
        val thousands = value / 1_000.0
        return if (thousands < 999.95) {
            oneDecimal(thousands) + "k"
        } else {
            oneDecimal(value / 1_000_000.0) + "M"
        }
    }

    private fun oneDecimal(value: Double): String = String.format(Locale.ROOT, "%.1f", value).removeSuffix(".0")
}
