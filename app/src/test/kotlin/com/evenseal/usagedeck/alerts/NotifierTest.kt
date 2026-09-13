package com.evenseal.usagedeck.alerts

import android.content.Context
import android.os.Vibrator
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.alerts.Alert
import com.evenseal.usagedeck.core.alerts.AlertKind
import com.evenseal.usagedeck.kiosk.DeckMode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class NotifierTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator

    private fun alert(kind: AlertKind) = Alert(kind, "$kind|k", "title", "body")

    @Test
    fun `warn vibrates with the short single buzz`() = runTest {
        val notifier = Notifier(context, TestScope(StandardTestDispatcher(testScheduler)))
        notifier.raise(alert(AlertKind.WARN), DeckMode.DOCK, quiet = false)
        assertArrayEquals(longArrayOf(0, 80), shadowOf(vibrator).pattern)
    }

    @Test
    fun `critical vibrates with the five pulse pattern`() = runTest {
        val notifier = Notifier(context, TestScope(StandardTestDispatcher(testScheduler)))
        notifier.raise(alert(AlertKind.CRITICAL), DeckMode.DOCK, quiet = false)
        assertArrayEquals(longArrayOf(0, 80, 80, 80, 80, 80), shadowOf(vibrator).pattern)
    }

    @Test
    fun `frozen vibrates with one long buzz`() = runTest {
        val notifier = Notifier(context, TestScope(StandardTestDispatcher(testScheduler)))
        notifier.raise(alert(AlertKind.FROZEN), DeckMode.DOCK, quiet = false)
        assertArrayEquals(longArrayOf(0, 400), shadowOf(vibrator).pattern)
    }

    @Test
    fun `unreachable vibrates with the two pulse pattern`() = runTest {
        val notifier = Notifier(context, TestScope(StandardTestDispatcher(testScheduler)))
        notifier.raise(alert(AlertKind.UNREACHABLE), DeckMode.DOCK, quiet = false)
        assertArrayEquals(longArrayOf(0, 80, 120, 80), shadowOf(vibrator).pattern)
    }

    @Test
    fun `quiet hours silence the haptic but still show the alert`() = runTest {
        val notifier = Notifier(context, TestScope(StandardTestDispatcher(testScheduler)))
        notifier.raise(alert(AlertKind.CRITICAL), DeckMode.DOCK, quiet = true)
        assertNull(shadowOf(vibrator).pattern)
        assertEquals(AlertKind.CRITICAL, notifier.overlay.value?.kind)
    }

    @Test
    fun `dock mode shows the overlay and clears it after eight seconds`() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val notifier = Notifier(context, scope)

        notifier.raise(alert(AlertKind.WARN), DeckMode.DOCK, quiet = false)
        runCurrent()
        assertEquals("body", notifier.overlay.value?.body)

        advanceTimeBy(7_000)
        runCurrent()
        assertEquals("body", notifier.overlay.value?.body)

        advanceTimeBy(1_500)
        runCurrent()
        assertNull(notifier.overlay.value)
    }

    @Test
    fun `battery mode posts a notification instead of the overlay`() = runTest {
        val notifier = Notifier(context, TestScope(StandardTestDispatcher(testScheduler)))
        notifier.raise(alert(AlertKind.WARN), DeckMode.BATTERY, quiet = false)
        runCurrent()

        assertNull(notifier.overlay.value)
        assertEquals(1, shadowOf(notifier.manager).allNotifications.size)
    }

    @Test
    fun `a channel exists for every alert kind`() = runTest {
        val notifier = Notifier(context, TestScope(StandardTestDispatcher(testScheduler)))
        AlertKind.entries.forEach { kind ->
            assertEquals(
                kind.name,
                notifier.manager.getNotificationChannel(Notifier.channelId(kind))?.id?.substringAfterLast('_')
            )
        }
    }
}
