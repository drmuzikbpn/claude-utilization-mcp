package com.evenseal.usagedeck

import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.evenseal.usagedeck.kiosk.LockTaskReceiver
import com.evenseal.usagedeck.kiosk.ScreenHold
import com.evenseal.usagedeck.pairing.PairingImport
import com.evenseal.usagedeck.service.DeckService
import com.evenseal.usagedeck.ui.DeckNav
import com.evenseal.usagedeck.ui.alerts.AlertOverlay
import com.evenseal.usagedeck.ui.kiosk.ExitGate
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The whole app is one activity: it is the launcher, the kiosk and the dashboard. Lock task is
 * entered here, and the only way out is the [ExitGate] corner.
 */
class MainActivity : ComponentActivity() {
    private val graph by lazy { (application as UsageDeckApp).graph }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (graph.kiosk.isDeviceOwner) {
            graph.kiosk.applyPolicies()
            graph.kiosk.startLockTask(this)
            // One tap, on first launch only, and only on a provisioned kiosk: Device Owner cannot
            // write the battery whitelist itself on API 29 (spec §4).
            if (!graph.kiosk.dozeExempt) graph.kiosk.requestDozeExemption(this)
        }
        consumePairingImport()
        DeckService.start(this)
        lifecycleScope.launch {
            combine(graph.settings.settings, graph.mode.mode) { prefs, mode ->
                ScreenHold.shouldHold(mode, prefs.keepScreenOn)
            }.collect { hold ->
                if (hold) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        setContent {
            Box(modifier = Modifier.fillMaxSize()) {
                DeckNav(graph)

                val overlay by graph.notifier.overlay.collectAsStateWithLifecycle()
                val mode by graph.mode.mode.collectAsStateWithLifecycle()
                AlertOverlay(
                    alert = overlay,
                    mode = mode,
                    onDismiss = { graph.notifier.dismissOverlay() }
                )

                ExitGate(
                    pin = graph.exitPin,
                    clock = graph.clock,
                    onUnlocked = ::openMaintenanceWindow,
                    modifier = Modifier.align(Alignment.TopStart)
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        consumePairingImport()
        // Coming back from the captive portal or the QR scanner must re-pin the deck, unless a
        // maintenance window is deliberately open.
        if (graph.kiosk.isDeviceOwner && System.currentTimeMillis() >= maintenanceUntil) {
            graph.kiosk.startLockTask(this)
        }
    }

    /**
     * Ten minutes out of lock task (spec §4). The re-arm is an alarm rather than a timer here,
     * so it survives this activity being backgrounded or the process being killed.
     */
    private fun openMaintenanceWindow() {
        maintenanceUntil = System.currentTimeMillis() + LockTaskReceiver.WINDOW_MILLIS
        graph.kiosk.stopLockTask(this)
        LockTaskReceiver.scheduleRelock(this, maintenanceUntil)
    }

    private companion object {
        /** Process-wide, so a config change cannot reopen the kiosk by accident. */
        @Volatile
        var maintenanceUntil: Long = 0L
    }

    /**
     * A sideloaded pairing file is picked up on every resume, not only at process start: the
     * kiosk process is protected and cannot be force-stopped, so "relaunch" often means resume.
     */
    private fun consumePairingImport() {
        val dirs = listOfNotNull(filesDir, getExternalFilesDir(null))
        when (val imported = PairingImport(dirs, graph.machineStore).consume()) {
            is PairingImport.Result.Imported -> Log.i(TAG, "paired ${imported.name} from import file")
            is PairingImport.Result.Rejected -> Log.w(TAG, "pairing import rejected: ${imported.reason}")
            PairingImport.Result.Nothing -> Unit
        }
    }
}

private const val TAG = "UsageDeck"
