package com.evenseal.usagedeck.ui

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.daemon.OkHttpDaemonApi
import com.evenseal.usagedeck.service.DeckGraph
import com.evenseal.usagedeck.ui.machine.MachineScreen
import com.evenseal.usagedeck.ui.pairing.PairingScreen
import com.evenseal.usagedeck.ui.settings.SettingsScreen
import com.evenseal.usagedeck.ui.wifi.WifiScreen
import com.evenseal.usagedeck.wifi.CaptivePortalActivity
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The bindings between the stateless screens and the graph. Keeping them here means every screen
 * stays a pure function of its arguments, which is what makes them testable without a daemon.
 */
@Composable
internal fun WifiRoute(graph: DeckGraph, vm: DeckViewModel, onBack: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val status by graph.wifi.status.collectAsStateWithLifecycle()
    val networks by graph.wifi.scanResults.collectAsStateWithLifecycle()
    val lastScanAt by graph.wifi.lastScanAt.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()

    WifiScreen(
        status = status,
        networks = networks,
        lastScanAt = lastScanAt,
        now = now,
        canRescan = lastScanAt == null || Duration.between(lastScanAt, now) >= RESCAN_INTERVAL,
        onRescan = { graph.wifi.requestScan() },
        onConnect = { ssid, passphrase -> graph.wifi.connect(ssid, passphrase) },
        onForget = { ssid -> graph.wifi.forget(ssid) },
        onCaptivePortal = { context.openCaptivePortal() },
        onBack = onBack
    )
}

@Composable
internal fun SettingsRoute(graph: DeckGraph, onBack: () -> Unit, onWifi: () -> Unit = {}) {
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val wifi by graph.wifi.status.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val checks = graph.updateChecks
    val label by (checks?.label ?: MutableStateFlow(NO_UPDATER)).collectAsStateWithLifecycle()

    SettingsScreen(
        settings = settings,
        version = BuildConfig.VERSION_NAME,
        updateState = label,
        onUpdate = { transform -> graph.settings.update(transform) },
        onSetPin = { pin ->
            graph.exitPin.set(pin)
            graph.settings.update { it.copy(pinSet = true) }
        },
        onCheckUpdate = { checks?.let { c -> scope.launch { c.checkNow() } } },
        onBack = onBack,
        wifiLabel = if (wifi.connected) wifi.ssid.orEmpty() else "not connected",
        onWifi = onWifi
    )
}

@Composable
internal fun MachineRoute(graph: DeckGraph, vm: DeckViewModel, machineId: String, onBack: () -> Unit) {
    MachineScreen(
        vm = vm,
        machineId = machineId,
        onUnpair = { id -> graph.machineStore.remove(id) },
        onBack = onBack
    )
}

@Composable
internal fun PairingRoute(graph: DeckGraph, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    PairingScreen(
        onPaired = { payload, report ->
            val config = payload.toConfig()
            graph.machineStore.add(config)
            report("Saved ${config.name}. Checking the daemon…")
            scope.launch {
                report(probe(graph, config))
            }
        },
        onBack = onBack
    )
}

/**
 * Spec §6.3: a 401 means the token is wrong and pairing must be re-run; anything else is saved
 * anyway and simply shows as unreachable, because a Mac that is merely asleep is still paired.
 */
private suspend fun probe(graph: DeckGraph, config: com.evenseal.usagedeck.core.model.MachineConfig): String =
    withContext(Dispatchers.IO) {
        try {
            OkHttpDaemonApi(config, graph.http).health()
            "Paired ${config.name}."
        } catch (e: DaemonException) {
            if (e.code == "unauthorized") {
                graph.machineStore.remove(config.id)
                "Token rejected. Re-run pairing on the Mac."
            } else {
                "Saved ${config.name}, but it is not answering yet: ${e.userMessage()}"
            }
        }
    }

private fun Context.openCaptivePortal() {
    runCatching {
        startActivity(
            Intent(this, CaptivePortalActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}

private val RESCAN_INTERVAL: Duration = Duration.ofSeconds(30)
private const val NO_UPDATER = "the background service is not running"
