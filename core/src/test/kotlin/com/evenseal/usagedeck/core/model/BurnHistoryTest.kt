package com.evenseal.usagedeck.core.model

import java.time.Duration
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BurnHistoryTest {
    private val t0 = Instant.parse("2026-09-13T14:00:00Z")

    @Test
    fun `rate over 60s window from two samples`() {
        val h = BurnHistory()
        h.record("s", t0, 1000)
        h.record("s", t0.plusSeconds(60), 4000)
        assertEquals(3000.0, h.ratePerMinute("s", t0.plusSeconds(60)), 0.01)
    }

    @Test
    fun `rate is zero with a single sample`() {
        val h = BurnHistory()
        h.record("s", t0, 1000)
        assertEquals(0.0, h.ratePerMinute("s", t0), 0.0)
    }

    @Test
    fun `rate is zero for an unknown key`() {
        assertEquals(0.0, BurnHistory().ratePerMinute("nope", t0), 0.0)
    }

    @Test
    fun `series buckets tokens per minute oldest first`() {
        val h = BurnHistory()
        for (i in 0..10) h.record("s", t0.plusSeconds(i * 60L), i * 600L) // 600 tokens/min steady
        val s = h.series("s", t0.plusSeconds(600), Duration.ofMinutes(10), 5)
        assertEquals(5, s.size)
        s.forEach { assertEquals(600.0, it, 1.0) }
    }

    @Test
    fun `series is all zeroes for an unknown key`() {
        val s = BurnHistory().series("nope", t0, Duration.ofMinutes(10), 4)
        assertEquals(listOf(0.0, 0.0, 0.0, 0.0), s)
    }

    @Test
    fun `cumulative drop resets baseline instead of negative rate`() {
        val h = BurnHistory()
        h.record("s", t0, 5000)
        h.record("s", t0.plusSeconds(30), 100)
        h.record("s", t0.plusSeconds(60), 400)
        assertTrue(h.ratePerMinute("s", t0.plusSeconds(60)) >= 0.0)
        assertEquals(600.0, h.ratePerMinute("s", t0.plusSeconds(60)), 0.01)
    }

    @Test
    fun `points older than retention are dropped`() {
        val h = BurnHistory(retention = Duration.ofMinutes(1))
        h.record("s", t0, 1)
        h.record("s", t0.plusSeconds(120), 2)
        // only one point survives
        assertEquals(0.0, h.ratePerMinute("s", t0.plusSeconds(120)), 0.0)
    }

    @Test
    fun `maxPoints caps the ring buffer`() {
        val h = BurnHistory(maxPoints = 3)
        for (i in 0..9) h.record("s", t0.plusSeconds(i * 10L), i * 100L)
        // the three newest points span 20 s and 200 tokens
        assertEquals(600.0, h.ratePerMinute("s", t0.plusSeconds(90), Duration.ofMinutes(5)), 0.01)
    }

    @Test
    fun `forget drops a key`() {
        val h = BurnHistory()
        h.record("s", t0, 1000)
        h.record("s", t0.plusSeconds(60), 4000)
        h.forget("s")
        assertEquals(0.0, h.ratePerMinute("s", t0.plusSeconds(60)), 0.0)
    }

    @Test
    fun `reads on one thread survive records on another`() {
        val history = BurnHistory()
        val t0 = Instant.parse("2026-09-13T12:00:00Z")
        val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
        val writer = Thread {
            repeat(20_000) { i ->
                history.record("k", t0.plusMillis(i.toLong()), i.toLong())
                if (i % 500 == 0) history.record("k", t0.plusMillis(i.toLong()), 0L)
            }
        }
        val reader = Thread {
            try {
                repeat(20_000) { i ->
                    history.ratePerMinute("k", t0.plusMillis(i.toLong()))
                    history.series("k", t0.plusMillis(i.toLong()), Duration.ofMinutes(30), 16)
                }
            } catch (t: Throwable) {
                failure.set(t)
            }
        }
        writer.start()
        reader.start()
        writer.join()
        reader.join()
        assertEquals(null, failure.get())
    }
}
