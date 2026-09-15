package com.evenseal.usagedeck.kiosk

import android.app.Application
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class LockTaskReceiverTest {
    private val app: Application = ApplicationProvider.getApplicationContext()

    private fun deliver(action: String) = LockTaskReceiver().onReceive(app, Intent(action))

    @Test
    fun `a package replacement relaunches the deck`() {
        deliver(Intent.ACTION_MY_PACKAGE_REPLACED)
        assertEquals(MainActivity::class.java.name, shadowOf(app).nextStartedActivity?.component?.className)
    }

    @Test
    fun `the relock alarm relaunches the deck`() {
        deliver(LockTaskReceiver.ACTION_RELOCK)
        assertEquals(MainActivity::class.java.name, shadowOf(app).nextStartedActivity?.component?.className)
    }

    @Test
    fun `other broadcasts are ignored`() {
        deliver(Intent.ACTION_BOOT_COMPLETED)
        assertNull(shadowOf(app).nextStartedActivity)
    }
}
