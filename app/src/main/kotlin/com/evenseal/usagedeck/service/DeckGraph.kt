package com.evenseal.usagedeck.service

import android.app.Application
import android.content.Context
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.alerts.Notifier
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.SystemClock
import com.evenseal.usagedeck.core.alerts.AlertEvaluator
import com.evenseal.usagedeck.core.daemon.DaemonApi
import com.evenseal.usagedeck.core.daemon.DaemonEventSource
import com.evenseal.usagedeck.core.daemon.MachineClient
import com.evenseal.usagedeck.core.daemon.OkHttpDaemonApi
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.pause.PauseController
import com.evenseal.usagedeck.kiosk.ExitPin
import com.evenseal.usagedeck.kiosk.KioskManager
import com.evenseal.usagedeck.kiosk.ModeController
import com.evenseal.usagedeck.pairing.MachineStore
import com.evenseal.usagedeck.pairing.encryptedPrefs
import com.evenseal.usagedeck.pause.PrefsEscalationStore
import com.evenseal.usagedeck.settings.SettingsStore
import com.evenseal.usagedeck.wifi.WifiRepository
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * The whole object graph, wired by hand and owned by [com.evenseal.usagedeck.UsageDeckApp].
 * There is no DI framework: the graph is small, singleton-shaped and easier to read as one file.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeckGraph(private val app: Application) {
    val clock: Clock = SystemClock

    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val http: OkHttpClient = OkHttpClient.Builder().build()

    val installId: String = UsageDeckApp.installIdOf(app)

    val machineStore: MachineStore = MachineStore.open(app)

    val settings: SettingsStore = SettingsStore(app.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE))

    val wifi: WifiRepository = WifiRepository(app, scope, clock)

    val mode: ModeController = ModeController(app)

    val kiosk: KioskManager = KioskManager(app)

    val exitPin: ExitPin = ExitPin(encryptedPrefs(app, PIN_PREFS), clock)

    val burn: BurnHistory = BurnHistory()

    private val _clients = MutableStateFlow<Map<String, MachineClient>>(emptyMap())
    val clients: StateFlow<Map<String, MachineClient>> = _clients.asStateFlow()

    private val apis = mutableMapOf<String, DaemonApi>()

    val team: StateFlow<TeamState> = clients
        .flatMapLatest { map ->
            if (map.isEmpty()) {
                flowOf(TeamState())
            } else {
                combine(map.values.map { it.state }) { states -> TeamState(states.toList()) }
            }
        }
        .stateIn(scope, SharingStarted.Eagerly, TeamState())

    val pause: PauseController = PauseController(
        team = team,
        apis = { machineId -> apis[machineId] },
        installId = installId,
        store = PrefsEscalationStore(app.getSharedPreferences(ESCALATION_PREFS, Context.MODE_PRIVATE)),
        clock = clock,
        scope = scope,
        settings = settings.pauseSettings
    )

    val evaluator: AlertEvaluator = AlertEvaluator(settings.thresholds, ZoneId.systemDefault())

    val notifier: Notifier = Notifier(app, scope)

    /** Keeps one [MachineClient] per paired machine, following [MachineStore] as it changes. */
    fun startClients() {
        scope.launch {
            machineStore.machines.collect { configs -> syncClients(configs) }
        }
    }

    fun stopClients() {
        _clients.value.values.forEach { it.stop() }
        _clients.value = emptyMap()
        apis.clear()
    }

    fun apiFor(machineId: String): DaemonApi? = apis[machineId]

    private fun syncClients(configs: List<MachineConfig>) {
        val wanted = configs.associateBy { it.id }
        val current = _clients.value

        current.filterKeys { it !in wanted.keys }.forEach { (id, client) ->
            client.stop()
            apis.remove(id)
        }

        val next = wanted.mapValues { (id, config) ->
            val existing = current[id]
            if (existing != null && existing.config == config) {
                existing
            } else {
                existing?.stop()
                newClient(config).also { it.start() }
            }
        }
        _clients.value = next
    }

    private fun newClient(config: MachineConfig): MachineClient {
        val api = OkHttpDaemonApi(config, http)
        apis[config.id] = api
        val source = DaemonEventSource(config, http)
        return MachineClient(
            config = config,
            api = api,
            eventSource = source::events,
            burn = burn,
            clock = clock,
            scope = scope,
            screenOn = mode.screenOn,
            tickerMs = TICKER_MS
        )
    }

    private companion object {
        const val SETTINGS_PREFS = "settings"
        const val ESCALATION_PREFS = "escalations"
        const val PIN_PREFS = "exit_pin"
        const val TICKER_MS = 1_000L
    }
}
