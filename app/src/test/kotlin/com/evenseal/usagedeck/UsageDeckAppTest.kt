package com.evenseal.usagedeck

import androidx.test.core.app.ApplicationProvider
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class UsageDeckAppTest {
    private val app: UsageDeckApp = ApplicationProvider.getApplicationContext()

    @Test
    fun `installId is a stable uuid`() {
        val first = app.installId
        assertEquals(first, UUID.fromString(first).toString())
        assertEquals(first, app.installId)
    }

    @Test
    fun `pauseReason is the reason string the daemon stores`() {
        assertEquals("usage-deck:${app.installId}", app.pauseReason)
        assertTrue(app.pauseReason.startsWith("usage-deck:"))
    }
}
