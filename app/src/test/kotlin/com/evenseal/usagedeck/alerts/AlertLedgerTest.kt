package com.evenseal.usagedeck.alerts

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AlertLedgerTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences("alerts-test", Context.MODE_PRIVATE)

    private fun ledger() = AlertLedger(prefs)

    private val key = "WARN|alan/org-1|weekly_all"
    private val window = 1_760_000_000_000L

    @Test
    fun `a window announces itself once`() {
        assertTrue(ledger().markFired(key, window))
        assertFalse(ledger().markFired(key, window))
    }

    @Test
    fun `the ledger survives process death, so a self-update cannot re-announce`() {
        assertTrue(ledger().markFired(key, window))
        // A fresh instance over the same prefs is what the deck has after an update restarts it.
        assertFalse(ledger().markFired(key, window))
    }

    @Test
    fun `the next window is news again`() {
        assertTrue(ledger().markFired(key, window))
        assertTrue(ledger().markFired(key, window + 604_800_000L))
    }

    @Test
    fun `falling back under the threshold forgets the crossing`() {
        val l = ledger()
        assertTrue(l.markFired(key, window))
        l.forget(key)
        assertTrue(l.markFired(key, window))
    }

    @Test
    fun `two limits on one account are tracked apart`() {
        val l = ledger()
        assertTrue(l.markFired(key, window))
        assertTrue(l.markFired("WARN|alan/org-1|session", window))
    }
}
