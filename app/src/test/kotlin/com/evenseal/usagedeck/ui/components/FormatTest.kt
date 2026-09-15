package com.evenseal.usagedeck.ui.components

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    @Test
    fun `frozen tag reads frozen once and frozen again with a count`() {
        assertEquals("frozen", Format.frozenTag(0))
        assertEquals("frozen", Format.frozenTag(1))
        assertEquals("frozen again ×2", Format.frozenTag(2))
        assertEquals("frozen again ×5", Format.frozenTag(5))
    }

    private val zone: ZoneId = ZoneId.of("Europe/London")

    /** 2026-09-13 is a Sunday; 14:02 local (BST = UTC+1). */
    private val now: Instant = Instant.parse("2026-09-13T13:02:00Z")

    @Test
    fun `tokens uses plain digits below a thousand`() {
        assertEquals("0", Format.tokens(0))
        assertEquals("999", Format.tokens(999))
    }

    @Test
    fun `tokens abbreviates thousands and millions`() {
        assertEquals("4.2k", Format.tokens(4_200))
        assertEquals("1.2M", Format.tokens(1_200_000))
        assertEquals("12.4M", Format.tokens(12_400_000))
    }

    @Test
    fun `tokens drops a trailing zero decimal`() {
        assertEquals("38k", Format.tokens(38_000))
        assertEquals("1k", Format.tokens(1_000))
        assertEquals("2M", Format.tokens(2_000_000))
    }

    @Test
    fun `tokens promotes to millions rather than printing a four digit k`() {
        assertEquals("1M", Format.tokens(999_999))
    }

    @Test
    fun `ratePerMin suffixes the abbreviated rate`() {
        assertEquals("38k/min", Format.ratePerMin(38_000.0))
        assertEquals("0/min", Format.ratePerMin(0.0))
        assertEquals("412/min", Format.ratePerMin(412.0))
    }

    @Test
    fun `ratePerMin rounds to the nearest token`() {
        assertEquals("413/min", Format.ratePerMin(412.6))
        assertEquals("0/min", Format.ratePerMin(-3.0))
    }

    @Test
    fun `resets renders unknown when the daemon has no reset time`() {
        assertEquals("resets: unknown", Format.resets(null, now, zone))
    }

    @Test
    fun `resets inside a day shows the local time and the remaining span`() {
        val at = Instant.parse("2026-09-13T15:35:00Z") // 16:35 London, 2 h 33 min away
        assertEquals("resets 16:35 · 2h33", Format.resets(at, now, zone))
    }

    @Test
    fun `resets under an hour shows only minutes`() {
        val at = Instant.parse("2026-09-13T13:09:00Z") // 14:09 London, 7 min away
        assertEquals("resets 14:09 · 7m", Format.resets(at, now, zone))
    }

    @Test
    fun `resets beyond a day shows the weekday`() {
        val at = Instant.parse("2026-09-17T08:00:00Z") // Thursday 09:00 London
        assertEquals("resets Thu 09:00", Format.resets(at, now, zone))
    }

    @Test
    fun `resets in the past clamps the remaining span to zero`() {
        val at = Instant.parse("2026-09-13T12:00:00Z") // 13:00 London, already gone
        assertEquals("resets 13:00 · 0m", Format.resets(at, now, zone))
    }

    @Test
    fun `resetCountdown shows the two largest units, compact`() {
        assertEquals("2d03h", Format.resetCountdown(now.plusSeconds(2 * 86_400 + 3 * 3_600 + 59 * 60), now))
        assertEquals("1h36m", Format.resetCountdown(now.plusSeconds(3_600 + 36 * 60 + 12), now))
        assertEquals("36m12s", Format.resetCountdown(now.plusSeconds(36 * 60 + 12), now))
        assertEquals("0m00s", Format.resetCountdown(now.minusSeconds(5), now))
        assertEquals("—", Format.resetCountdown(null, now))
    }

    @Test
    fun `countdown is minutes and padded seconds`() {
        assertEquals("0:42", Format.countdown(now.plusSeconds(42), now))
        assertEquals("12:05", Format.countdown(now.plusSeconds(725), now))
    }

    @Test
    fun `countdown floors at zero once the deadline has passed`() {
        assertEquals("0:00", Format.countdown(now.minusSeconds(5), now))
        assertEquals("0:00", Format.countdown(now, now))
    }

    @Test
    fun `shortId keeps the first four characters`() {
        assertEquals("a1b2…", Format.shortId("a1b2c3d4-e5f6"))
        assertEquals("abc…", Format.shortId("abc"))
    }

    @Test
    fun `age steps from seconds to days`() {
        assertEquals("4s ago", Format.age(now.minusSeconds(4), now))
        assertEquals("3m ago", Format.age(now.minusSeconds(180), now))
        assertEquals("2h ago", Format.age(now.minusSeconds(7_200), now))
        assertEquals("3d ago", Format.age(now.minusSeconds(3 * 86_400), now))
    }

    @Test
    fun `age of nothing is never and the future reads as now`() {
        assertEquals("never", Format.age(null, now))
        assertEquals("0s ago", Format.age(now.plusSeconds(30), now))
    }

    @Test
    fun `resetsShort is a bare span inside a day and a weekday time beyond it`() {
        val now = Instant.parse("2026-09-13T14:02:00Z")
        val zone = ZoneId.of("UTC")
        assertEquals("2h33 left", Format.resetsShort(now.plusSeconds(2 * 3600 + 33 * 60), now, zone))
        assertEquals("Thu 09:00", Format.resetsShort(Instant.parse("2026-09-17T09:00:00Z"), now, zone))
        assertEquals("unknown", Format.resetsShort(null, now, zone))
    }

    @Test
    fun `model ids shorten to their family`() {
        assertEquals("opus", Format.modelShort("claude-opus-5"))
        assertEquals("fable", Format.modelShort("claude-fable-5-1"))
        assertEquals("haiku", Format.modelShort("claude-haiku-4-5-20251001"))
        assertEquals("gpt", Format.modelShort("gpt"))
        assertEquals(null, Format.modelShort(null))
    }

    @Test
    fun `host names drop their domain`() {
        assertEquals("macbook-pro-10", Format.hostShort("macbook-pro-10.tail42c6d2.ts.net"))
        assertEquals("studio", Format.hostShort("studio"))
    }

    @Test
    fun `billions get their own suffix instead of thousands of M`() {
        assertEquals("3.1B", Format.tokens(3_055_500_000))
        assertEquals("999.9M", Format.tokens(999_940_000))
    }

    @Test
    fun `the clock renders 24-hour or 12-hour`() {
        val at = Instant.parse("2026-09-13T22:21:00Z")
        assertEquals("18:21", Format.clock(at, ZoneId.of("America/New_York"), use24h = true))
        assertEquals("6:21 PM", Format.clock(at, ZoneId.of("America/New_York"), use24h = false))
    }
}
