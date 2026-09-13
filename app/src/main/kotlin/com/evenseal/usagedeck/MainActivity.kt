package com.evenseal.usagedeck

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.evenseal.usagedeck.service.DeckService
import com.evenseal.usagedeck.ui.DeckNav

/**
 * The whole app is one activity: it is the launcher, the kiosk and the dashboard. Lock task is
 * entered here, and the only way out is the [com.evenseal.usagedeck.ui.kiosk.ExitGate] corner.
 */
class MainActivity : ComponentActivity() {
    private val graph by lazy { (application as UsageDeckApp).graph }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (graph.kiosk.isDeviceOwner) {
            graph.kiosk.applyPolicies()
            graph.kiosk.startLockTask(this)
        }
        if (!graph.kiosk.dozeExempt) {
            graph.kiosk.requestDozeExemption(this)
        }
        DeckService.start(this)

        setContent { DeckNav(graph) }
    }
}
