// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.pairing.PairingInvite
import com.evenseal.usagedeck.kiosk.ExitPin
import com.evenseal.usagedeck.service.DeckGraph
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.usersWithData
import com.evenseal.usagedeck.ui.machine.MachineScreen
import com.evenseal.usagedeck.ui.pairing.PairingScreen
import com.evenseal.usagedeck.ui.pairing.PairingStatus
import com.evenseal.usagedeck.ui.pairing.ReplaceTarget
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
internal fun SettingsRoute(graph: DeckGraph, onBack: () -> Unit, onWifi: () -> Unit = {}, onPair: () -> Unit = {}) {
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val wifi by graph.wifi.status.collectAsStateWithLifecycle()
    val team by graph.team.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val checks = graph.updateChecks
    val label by (checks?.label ?: MutableStateFlow(NO_UPDATER)).collectAsStateWithLifecycle()

    SettingsScreen(
        settings = settings,
        version = BuildConfig.VERSION_NAME,
        updateState = label,
        onUpdate = { transform -> graph.settings.update(transform) },
        onSetPin = { current, new -> setOrChangePin(graph, current, new) },
        onCheckUpdate = { checks?.let { c -> scope.launch { c.checkNow() } } },
        onBack = onBack,
        wifiLabel = if (wifi.connected) wifi.ssid.orEmpty() else "not connected",
        onWifi = onWifi,
        onPair = onPair,
        users = team.usersWithData()
    )
}

@Composable
internal fun MachineRoute(
    graph: DeckGraph,
    vm: DeckViewModel,
    machineId: String,
    onBack: () -> Unit,
    onRepair: (String) -> Unit
) {
    MachineScreen(
        vm = vm,
        machineId = machineId,
        onUnpair = { id -> graph.machineStore.remove(id) },
        onBack = onBack,
        onRepair = onRepair
    )
}

@Composable
internal fun PairingRoute(graph: DeckGraph, onBack: () -> Unit, replacing: String? = null) {
    val scope = rememberCoroutineScope()
    val redeeming by graph.invitePairing.redeeming.collectAsStateWithLifecycle()
    val team by graph.team.collectAsStateWithLifecycle()
    // The row a Re-pair card sent us to replace, by every name it goes by.
    val target = replacing?.let { id ->
        val stored = graph.machineStore.machines.value.firstOrNull { it.id == id } ?: return@let null
        ReplaceTarget(id, listOfNotNull(stored.name, team.machine(id)?.name).distinct())
    }
    PairingScreen(
        redeeming = redeeming,
        replacing = target,
        // A QR whose address is already paired under another certificate would swap that
        // machine's identity: ask first. Pairing a retired row again, or the same key, is not that.
        conflictOf = { invite ->
            graph.machineStore.wouldReplace(invite)
                ?.takeIf { it.isPinned && it.fp != invite.fp }
                ?.let { ReplaceTarget(it.id, listOfNotNull(it.name, team.machine(it.id)?.name).distinct()) }
        },
        onScanned = { invite, replaceId, mayReplace, report ->
            report(PairingStatus("Pairing with ${invite.name}…", busy = true))
            // The graph's scope, not the screen's: the code is single use, so a redeem
            // that has started must finish and store its token even if the screen closes.
            graph.scope.launch {
                val outcome = redeem(graph, invite, replaceId, mayReplace)
                withContext(Dispatchers.Main) { report(PairingStatus(outcome)) }
            }
        },
        onBack = onBack
    )
}

/** Daemon §23.47: the code buys the bearer over pinned HTTPS; errors are the daemon's own hints. */
private suspend fun redeem(graph: DeckGraph, invite: PairingInvite, replacing: String?, mayReplace: Boolean): String =
    try {
        "Paired ${graph.invitePairing.pair(invite, replacing, mayReplace).name}."
    } catch (e: DaemonException) {
        e.userMessage()
    }

/**
 * The first PIN is simply set. After that the current PIN is required, and it goes through
 * `ExitPin.verify`, so guessing here is counted and locked out exactly like guessing at the gate.
 * Returns what to tell the user, or null when the new PIN is saved.
 */
internal fun setOrChangePin(graph: DeckGraph, current: String?, new: String): String? {
    val verdict = if (graph.exitPin.isSet()) {
        graph.exitPin.change(current.orEmpty(), new)
    } else {
        graph.exitPin.set(new)
        ExitPin.Result.Ok
    }
    return when (verdict) {
        ExitPin.Result.Ok -> {
            graph.settings.update { it.copy(pinSet = true) }
            null
        }
        is ExitPin.Result.Wrong -> "Current PIN is wrong · ${verdict.remaining} left"
        is ExitPin.Result.LockedOut -> "Locked out for ${Format.countdown(verdict.until, graph.clock.now())}"
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
