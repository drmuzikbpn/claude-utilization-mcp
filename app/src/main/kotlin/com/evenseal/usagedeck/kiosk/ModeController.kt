package com.evenseal.usagedeck.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Dock is "on power", Battery is everything else. Spec §5. */
enum class DeckMode { DOCK, BATTERY }

/**
 * Tracks the two inputs that decide how the deck renders: whether the phone is on power
 * (dock vs battery) and whether the screen is on.
 */
class ModeController(private val context: Context) {
    private val _mode = MutableStateFlow(readInitialMode())
    val mode: StateFlow<DeckMode> = _mode.asStateFlow()

    private val _screenOn = MutableStateFlow(readInitialScreenOn())
    val screenOn: StateFlow<Boolean> = _screenOn.asStateFlow()

    private var receiver: BroadcastReceiver? = null

    fun start() {
        if (receiver != null) return
        _mode.value = readInitialMode()
        _screenOn.value = readInitialScreenOn()
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_POWER_CONNECTED -> _mode.value = DeckMode.DOCK
                    Intent.ACTION_POWER_DISCONNECTED -> _mode.value = DeckMode.BATTERY
                    Intent.ACTION_SCREEN_ON -> _screenOn.value = true
                    Intent.ACTION_SCREEN_OFF -> _screenOn.value = false
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        context.registerReceiver(r, filter)
        receiver = r
    }

    fun stop() {
        val r = receiver ?: return
        receiver = null
        runCatching { context.unregisterReceiver(r) }
    }

    private fun readInitialMode(): DeckMode {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val charging = runCatching { bm?.isCharging == true }.getOrDefault(false)
        return if (charging) DeckMode.DOCK else DeckMode.BATTERY
    }

    private fun readInitialScreenOn(): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return runCatching { power.isInteractive }.getOrDefault(true)
    }
}
