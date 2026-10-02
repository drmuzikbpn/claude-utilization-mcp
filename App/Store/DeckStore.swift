import Foundation
import Observation
import UsageCore
import WidgetKit

/// The whole iPhone app's state: paired devices, one `DeviceClient` each, the merged `TeamState`,
/// pause and escalation, alerts, settings and pairing. Every screen reads this one object, so
/// nothing on screen can disagree with anything else on it.
@MainActor
@Observable
final class DeckStore {
    enum Route: Hashable {
        case projects
        case project(deviceId: String, key: String)
        case device(String)
        case settings
    }

    // MARK: - observed state

    private(set) var records: [DeviceRecord] = []
    private(set) var team = TeamState()
    /// The one-second ticker every countdown and age on screen reads.
    private(set) var now = Date()
    var settings: DeckSettings {
        didSet { settingsChanged() }
    }

    /// The latest warn/critical body, shown in the status bar for a minute.
    private(set) var alertChip: String?
    /// A short failure line (pause refused, device unreachable), shown at the bottom for a few seconds.
    private(set) var toast: String?
    private(set) var toastSerial = 0
    private(set) var setupChecks: [String: SetupCheck] = [:]
    private(set) var checking: Set<String> = []

    var path: [Route] = []
    /// Ledger rows the user unfolded: `user|<key>` and `<deviceId>|<projectKey>`.
    var expanded: Set<String> = []

    /// Pairing
    var showPairing = false
    /// A parsed invite waiting for the "Pair <name>?" confirmation.
    var pendingInvite: PairingInvite?
    var pairingError: String?
    private(set) var pairingInFlight = false
    /// Set by "Re-pair" on a device: the next redeemed invite replaces that device's token.
    private(set) var replacingDeviceId: String?
    /// A device just paired: "Connecting to <name>…" shows until its first full load is in.
    private(set) var connect = ConnectTracker()

    var connecting: ConnectTracker.Attempt? {
        connect.current
    }

    let pause: PauseController

    // MARK: - plumbing

    @ObservationIgnored let burn = BurnHistory()
    /// Called with every rebuilt snapshot; `WatchBridge` decides what is worth sending.
    @ObservationIgnored var onSnapshot: ((WatchSnapshot) -> Void)?

    @ObservationIgnored private let tokens: any TokenStore
    @ObservationIgnored private let registry: DeviceRegistry
    @ObservationIgnored private let settingsStore: DeckSettingsStore
    @ObservationIgnored private let ledger: AlertLedger
    @ObservationIgnored private let repairLedger: RepairLedger
    @ObservationIgnored private let notifier: AlertNotifier
    @ObservationIgnored private let shared: SharedSnapshotStore
    @ObservationIgnored private var clients: [String: DeviceClient] = [:]
    @ObservationIgnored private var observers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var states: [String: DeviceState] = [:]
    @ObservationIgnored private(set) var isForeground = false
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var chipTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var bootstrapTask: Task<Void, Never>?
    @ObservationIgnored private var connectTimer: Task<Void, Never>?
    @ObservationIgnored private var widgetSnapshot: WatchSnapshot?
    @ObservationIgnored private(set) var snapshot = WatchSnapshot.empty

    init(
        defaults: UserDefaults = .standard,
        group: UserDefaults = AppGroup.defaults,
        tokens: any TokenStore = KeychainTokenStore(),
        notifier: AlertNotifier = AlertNotifier(),
        shared: SharedSnapshotStore = SharedSnapshotStore()
    ) {
        let box = StoreRef()
        self.tokens = tokens
        self.notifier = notifier
        self.shared = shared
        registry = DeviceRegistry(defaults: defaults)
        settingsStore = DeckSettingsStore(defaults: defaults)
        settings = settingsStore.load()
        ledger = AlertLedger(defaults: group)
        repairLedger = RepairLedger(defaults: group)
        pause = PauseController(
            team: { box.store?.team ?? TeamState() },
            apis: { box.store?.clients[$0]?.api },
            installId: InstallID.load(defaults),
            store: UserDefaultsEscalationStore(defaults: group),
            escalationSeconds: { box.store?.settings.escalationSeconds }
        )
        box.store = self
        records = registry.load()
        for record in records {
            connect(record)
        }
        fold()
    }

    #if DEBUG
        /// `-UsageDeckDemo`: made-up devices with no clients behind them (see `DemoData`).
        func seedDemo() {
            let at = Date()
            var devices = DemoData.devices(now: at)
            if DemoData.needsRepair {
                devices[0].repairReason = .tokenRejected
                devices[0].lastError = DaemonError(code: "unauthorized").userMessage
            }
            DemoData.seedBurn(burn, devices: devices, now: at)
            records = devices.map(\.record)
            for device in devices {
                states[device.id] = device
            }
            fold()
            if DemoData.opensConnecting, let studio = devices.first {
                seedConnecting(studio)
            }
        }

        /// Plays a pairing's first load for `studio`: nothing in hand, then all of it at once.
        private func seedConnecting(_ studio: DeviceState) {
            var waiting = studio
            waiting.summaryLoaded = false
            states[studio.id] = waiting
            if DemoData.holdsConnecting {
                connect = ConnectTracker(timeout: 600)
            }
            _ = connect.begin(deviceId: studio.id, name: studio.record.name, now: Date())
            armConnectTimer()
            fold()
            guard !DemoData.holdsConnecting else { return }
            Task { [weak self] in
                try? await Task.sleep(for: DemoData.connectingDelay)
                guard let self, let attempt = connecting else { return }
                var arrived = studio
                arrived.summaryLoaded = true
                states[studio.id] = arrived
                setupChecks[studio.id] = SetupCheck.evaluate(health: DemoData.health(studio), error: nil, limitsFresh: true)
                connect.settle(attempt.id)
                fold()
            }
        }
    #endif

    // MARK: - lifecycle

    /// Foreground: SSE streams, the escalation timer and the ticker run. Background: all stop;
    /// background refresh and watch requests use one-shot REST instead.
    func setActive(_ active: Bool) {
        guard active != isForeground else { return }
        isForeground = active
        let all = Array(clients.values)
        if active {
            for client in all {
                Task {
                    await client.setForeground(true)
                    await client.start()
                }
            }
            pause.start()
            startTicker()
            // A device still connecting gets its check from `bootstrap`, after its first refresh.
            for record in records where record.id != connecting?.deviceId {
                Task { await runSetupCheck(record.id, quietly: true) }
            }
            // Requests that were in flight when the app was suspended are no answer: start over.
            if let attempt = connect.resume(now: Date()) {
                startBootstrap(attempt)
                armConnectTimer()
            }
        } else {
            connect.pause(now: Date())
            connectTimer?.cancel()
            bootstrapTask?.cancel()
            for client in all {
                Task { await client.stop() }
            }
            pause.stop()
            ticker?.cancel()
            ticker = nil
        }
    }

    /// One REST pass over every device (background refresh, a watch `{refresh}` while the app
    /// is not streaming), then alerts, the widget snapshot and the watch.
    func refreshAll() async {
        await pause.tick()
        let all = Array(clients.values)
        await withTaskGroup(of: (DeviceClient, DeviceState).self) { group in
            for client in all {
                group.addTask {
                    await client.refresh()
                    return await (client, client.state)
                }
            }
            for await (client, state) in group {
                ingest(state, from: client)
            }
        }
        fold()
    }

    /// The `BGAppRefreshTask` body. Always rewrites the widgets' snapshot: a background wake is
    /// exactly when they are most likely to be behind.
    func backgroundRefresh() async {
        await refreshAll()
        guard !Task.isCancelled else { return }
        writeWidgets(snapshot)
    }

    private func startTicker() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { return }
                now = Date()
                fold()
            }
        }
    }

    // MARK: - devices

    private func connect(_ record: DeviceRecord) {
        guard let token = tokens.token(for: record.id) else {
            var orphan = DeviceState(record: record)
            // No token in the Keychain to offer it: as good as rejected.
            orphan.repairReason = .tokenRejected
            orphan.lastError = DaemonError.defaults["unauthorized"]
            states[record.id] = orphan
            return
        }
        let client = DeviceClient.live(config: DeviceConfig(record: record, token: token), burn: burn)
        clients[record.id] = client
        observers[record.id] = Task { [weak self] in
            for await state in await client.states() {
                self?.ingest(state, from: client)
            }
        }
        if isForeground {
            Task {
                await client.setForeground(true)
                await client.start()
            }
        }
    }

    private func disconnect(_ id: String) {
        observers.removeValue(forKey: id)?.cancel()
        if let client = clients.removeValue(forKey: id) {
            Task { await client.stop() }
        }
        states[id] = nil
    }

    /// Only the device's current client may speak for it: after a re-pair, a late answer from
    /// the replaced client (still holding the old token) must not mark the device again.
    private func ingest(_ state: DeviceState, from client: DeviceClient) {
        guard clients[state.id] === client else { return }
        states[state.id] = state
        fold()
    }

    func remove(_ id: String) {
        disconnect(id)
        tokens.removeToken(for: id)
        registry.remove(id)
        repairLedger.forget(id)
        records.removeAll { $0.id == id }
        setupChecks[id] = nil
        burn.forget(prefix: "\(id)/")
        path.removeAll { $0 == .device(id) }
        fold()
    }

    /// Reads `/health` for the device detail checklist and folds any new TLS listener into the
    /// device's candidate addresses. `quietly` keeps the spinner off (the foreground sweep).
    func runSetupCheck(_ id: String, quietly: Bool = false) async {
        guard let client = clients[id] else {
            setupChecks[id] = SetupCheck.evaluate(health: nil, error: DaemonError(code: "unauthorized"), limitsFresh: false)
            return
        }
        if !quietly {
            checking.insert(id)
        }
        defer { checking.remove(id) }
        setupChecks[id] = await evaluateSetup(id, client: client)
    }

    private func evaluateSetup(_ id: String, client: DeviceClient) async -> SetupCheck {
        do {
            let health = try await client.api.health()
            mergeAddresses(id, reported: health.tlsAddrs, api: client.api)
            let limitsFresh = !(states[id]?.limits.isEmpty ?? true)
            return SetupCheck.evaluate(health: health, error: nil, limitsFresh: limitsFresh)
        } catch {
            return SetupCheck.evaluate(health: nil, error: DaemonError.from(transport: error), limitsFresh: false)
        }
    }

    private func mergeAddresses(_ id: String, reported: [String], api: any DaemonAPI) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        let merged = AddressMerge.merge(paired: records[index].addrs, reported: reported)
        guard merged != records[index].addrs else { return }
        records[index].addrs = merged
        registry.save(records)
        (api as? URLSessionDaemonAPI)?.endpoints.replace(records[index].baseURLs)
    }

    // MARK: - folding

    /// Rebuilds the team from the latest device states, re-ages health off this phone's clock,
    /// raises alerts on a change and hands a fresh snapshot to the widgets and the watch.
    func fold() {
        let at = Date()
        let devices = records.map { record -> DeviceState in
            var state = states[record.id] ?? DeviceState(record: record)
            state.record = record
            state.health = Aging.health(lastHeartbeatAt: state.lastHeartbeatAt, now: at)
            return state
        }
        let next = TeamState(devices: devices)
        let previous = team
        if next != previous {
            team = next
            raiseAlerts(previous: previous, next: next, at: at)
        }
        publish(at: at)
    }

    private func publish(at: Date) {
        let built = WatchSnapshot.make(
            team: team,
            escalations: pause.pending,
            names: settings.names,
            burn: burn,
            use24h: settings.use24h,
            now: at
        )
        snapshot = built
        // Widgets age by generatedAt too (20 min to stale), so refresh an unchanged one every 10 min.
        if SnapshotDiff.isDue(last: widgetSnapshot, next: built, heartbeat: 600, headlineOnly: true) {
            writeWidgets(built)
        }
        onSnapshot?(built)
    }

    private func writeWidgets(_ snapshot: WatchSnapshot) {
        widgetSnapshot = snapshot
        shared.write(snapshot)
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func raiseAlerts(previous: TeamState, next: TeamState, at: Date) {
        let names = settings.names
        let evaluator = AlertEvaluator(thresholds: settings.thresholds, nameFor: { names.name(for: $0) })
        for key in evaluator.cleared(next) {
            ledger.forget(key)
        }
        let raised = ledger.admit(DeckAlerts.admissible(evaluator.evaluate(previous: previous, next: next), previous: previous))
            + repairLedger.review(next, now: at)
        guard !raised.isEmpty else { return }
        let quiet = settings.isQuiet(at: at)
        for alert in raised {
            notifier.post(alert, quiet: quiet)
        }
        if let limit = raised.last(where: { $0.kind == .warn || $0.kind == .critical }) {
            showChip(limit.body)
        }
    }

    private func showChip(_ text: String) {
        alertChip = text
        chipTask?.cancel()
        chipTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            self?.alertChip = nil
        }
    }

    static let toastDuration: Duration = .seconds(4)

    func showToast(_ text: String) {
        toast = text
        toastSerial += 1
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: Self.toastDuration)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    private func settingsChanged() {
        settingsStore.save(settings)
        publish(at: Date())
    }

    // MARK: - pause

    func visual(_ target: PauseTarget) -> PauseVisual {
        PauseVisuals.visual(target, team: team, now: now, inFlight: pause.inFlight, escalation: pause.escalation(for: target))
    }

    /// Tap: resume when paused, soft pause otherwise.
    func tap(_ target: PauseTarget) {
        Task { await report(pause.tap(target), target: target) }
    }

    /// After the "Freeze?" confirmation.
    func freeze(_ target: PauseTarget) {
        Task { await report(pause.hold(target), target: target) }
    }

    private func report(_ outcomes: [PauseOutcome], target: PauseTarget) async {
        publish(at: Date())
        let failed = outcomes.filter { !$0.ok }
        guard !failed.isEmpty else { return }
        if target == .all, outcomes.count > 1 {
            let names = failed.map { team.device($0.deviceId)?.displayName ?? $0.deviceId }
            let detail = failed.first?.error ?? DaemonError.network.userMessage
            showToast("\(outcomes.count - failed.count) of \(outcomes.count) done · \(names.joined(separator: ", ")): \(detail)")
        } else {
            showToast(failed.first?.error ?? DaemonError.network.userMessage)
        }
    }

    // MARK: - order

    /// The portrait list: live projects fastest first, each with its sessions fastest first.
    var liveProjects: [ProjectView] {
        ActivityOrder.projects(
            team.projects,
            projectRate: { self.projectRate(deviceId: $0.deviceId, key: $0.key) },
            sessionRate: { self.rate(deviceId: $0.deviceId, sessionId: $1.sessionId) }
        )
    }

    /// The landscape list: every live session, fastest first, whichever project it is in.
    var liveRows: [ActivityOrder.Row] {
        ActivityOrder.sessions(team.projects) { self.rate(deviceId: $0.deviceId, sessionId: $1.sessionId) }
    }

    // MARK: - burn

    func rate(deviceId: String, sessionId: String) -> Double {
        burn.ratePerMinute(DeviceReducer.burnKey(deviceId: deviceId, session: sessionId), now: now)
    }

    func projectRate(deviceId: String, key: String) -> Double {
        burn.ratePerMinute(DeviceReducer.burnKey(deviceId: deviceId, project: key), now: now)
    }

    /// The rows' 30-minute sparkline.
    func series(deviceId: String, sessionId: String) -> [Double] {
        burn.series(DeviceReducer.burnKey(deviceId: deviceId, session: sessionId), now: now, window: 30 * 60, buckets: 16)
    }

    func projectSparkline(deviceId: String, key: String) -> [Double] {
        burn.series(DeviceReducer.burnKey(deviceId: deviceId, project: key), now: now, window: 30 * 60, buckets: 16)
    }

    /// The project drill-in's five-hour chart.
    func projectSeries(deviceId: String, key: String) -> [Double] {
        burn.series(DeviceReducer.burnKey(deviceId: deviceId, project: key), now: now, window: 5 * 3600, buckets: 30)
    }

    // MARK: - people

    func name(for user: UserView) -> String {
        settings.names.name(for: user)
    }

    func rename(_ key: String, to name: String) {
        settings.names = settings.names.renamed(key, to: name)
    }

    func toggle(_ id: String) {
        if expanded.contains(id) {
            expanded.remove(id)
        } else {
            expanded.insert(id)
        }
    }

    // MARK: - pairing

    /// A `usagedeck://pair?...` link opened from the Camera or another app.
    func handle(url: URL) {
        if !showPairing {
            // A link from outside is a new pairing unless the user is mid-"Re-pair".
            replacingDeviceId = nil
        }
        offer(PairingInput.classify(url.absoluteString))
    }

    /// A scanned or pasted pairing string.
    func offer(_ input: PairingInput) {
        switch input {
        case let .invite(invite):
            pairingError = nil
            pendingInvite = invite
        case let .rejected(message):
            pairingError = message
            showPairing = true
        }
    }

    func beginPairing(replacing id: String? = nil) {
        replacingDeviceId = id.flatMap { id in records.contains { $0.id == id } ? id : nil }
        pairingError = nil
        showPairing = true
    }

    func cancelPairing() {
        pendingInvite = nil
        replacingDeviceId = nil
        showPairing = false
    }

    /// Redeems the confirmed invite over pinned HTTPS, keeps the token in the Keychain only,
    /// connects, asks for notification permission and runs the setup check at once.
    /// The record a "Re-pair" is about to replace, when the scanned invite does not look like the
    /// same device (different name and addresses): the confirmation asks before replacing it.
    func replacementConflict(_ invite: PairingInvite) -> DeviceRecord? {
        guard let id = replacingDeviceId, let old = records.first(where: { $0.id == id }) else { return nil }
        return RepairMatch.sameDevice(old, invite) ? nil : old
    }

    /// `replace: false` ("Pair as new") ignores the pending Re-pair and pairs the invite as its
    /// own device (or the one already holding its certificate).
    func confirmPairing(_ invite: PairingInvite, replace: Bool = true) async {
        // One pairing at a time: a link that arrives mid-pairing waits for its confirmation
        // until the overlay has closed.
        guard !pairingInFlight, connecting == nil else {
            pendingInvite = invite
            return
        }
        pendingInvite = nil
        pairingInFlight = true
        defer { pairingInFlight = false }
        let replacing = replace ? replacingDeviceId : nil
        let reuse = replacing.flatMap { id in records.contains { $0.id == id } ? id : nil }
            ?? records.first { $0.fingerprint == invite.fingerprint }?.id
        do {
            let config = try await PairingClient(invite: invite).redeem(invite, id: reuse ?? UUID().uuidString)
            try tokens.setToken(config.token, for: config.id)
            var record = config.record
            if let old = records.first(where: { $0.id == record.id }) {
                record.addrs = AddressMerge.merge(paired: record.addrs, reported: old.addrs)
            }
            disconnect(record.id)
            if let index = records.firstIndex(where: { $0.id == record.id }) {
                records[index] = record
            } else {
                records.append(record)
            }
            registry.save(records)
            repairLedger.forget(record.id)
            setupChecks[record.id] = nil
            connect(record)
            fold()
            replacingDeviceId = nil
            showPairing = false
            pairingError = nil
            if let attempt = connect.begin(deviceId: record.id, name: record.name, now: Date()) {
                startBootstrap(attempt)
                armConnectTimer()
            }
        } catch {
            pairingError = DaemonError.from(transport: error).userMessage
            showPairing = true
        }
    }

    /// Where the connecting overlay stands; nil when it is not showing.
    var connectingPhase: FirstLoad.Phase? {
        guard let attempt = connecting else { return nil }
        return connect.phase(state: team.device(attempt.deviceId), check: setupChecks[attempt.deviceId], now: now)
    }

    private func startBootstrap(_ attempt: Int) {
        guard let deviceId = connect.current?.deviceId else { return }
        bootstrapTask?.cancel()
        setupChecks[deviceId] = nil
        bootstrapTask = Task { [weak self] in await self?.bootstrap(attempt, deviceId: deviceId) }
    }

    /// One REST pass and then the setup check, in that order, so the checklist's "Usage limits"
    /// row sees the limits the pass brought in. Results only count for the attempt that asked.
    private func bootstrap(_ attempt: Int, deviceId: String) async {
        guard let client = clients[deviceId] else { return }
        // Not cancelled with us: a cancelled URLSession request would read as "Device
        // unreachable" in the device's own state.
        await Task { await client.refresh() }.value
        guard !Task.isCancelled, connect.current?.id == attempt else { return }
        await ingest(client.state, from: client)
        let check = await evaluateSetup(deviceId, client: client)
        guard !Task.isCancelled, connect.current?.id == attempt else { return }
        setupChecks[deviceId] = check
        connect.settle(attempt)
    }

    /// The timeout runs off its own timer, over foreground time only (paused in the background).
    private func armConnectTimer() {
        connectTimer?.cancel()
        guard let attempt = connecting?.id, let remaining = connect.remaining(now: Date()) else { return }
        connectTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled else { return }
            self?.connect.expire(attempt)
        }
    }

    /// Closes the connecting overlay onto the device screen (also its Skip button). `message`
    /// is the reason it stopped waiting, shown as a toast; the notification permission prompt
    /// waits until the toast has been read rather than covering it.
    func finishConnecting(_ attempt: Int, message: String? = nil) {
        guard let done = connect.finish(attempt) else { return }
        bootstrapTask?.cancel()
        connectTimer?.cancel()
        if records.contains(where: { $0.id == done.deviceId }) {
            path = [.device(done.deviceId)]
        }
        guard let message else {
            notifier.requestAuthorization()
            return
        }
        showToast(message)
        Task { [weak self] in
            try? await Task.sleep(for: Self.toastDuration + .milliseconds(500))
            self?.notifier.requestAuthorization()
        }
    }
}

/// Lets `PauseController`'s closures reach the store without a retain cycle or a half-built self.
@MainActor
private final class StoreRef {
    weak var store: DeckStore?
}

enum AppGroup {
    /// The App Group suite: escalations and the alert ledger live here so a background wake sees
    /// the same state the foreground app wrote. Falls back to standard when the group is missing.
    nonisolated(unsafe) static let defaults = UserDefaults(suiteName: SharedSnapshotStore.appGroup) ?? .standard
}
