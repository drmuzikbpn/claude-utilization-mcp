import Foundation

/// Owns one paired device's live `DeviceState`.
///
/// `start()` runs an SSE loop with backoff; after two consecutive connects that never opened it
/// also polls REST (2 s in the foreground, 30 s otherwise) until SSE opens again. A ticker
/// re-derives health from the last heartbeat, and per-project token totals refresh every 30 s.
/// `refresh()` is the one-shot REST bootstrap for background refresh and the watch's `{refresh}`.
/// Errors never escape; they land in `state.lastError` (and `repairReason` on a 401 / pin mismatch).
/// A device that rejects this iPhone is not hammered: polling stops and SSE drops to one probe
/// every `repairProbe`, so a restored token or a re-pair brings it back.
public actor DeviceClient {
    public struct Timing: Sendable {
        public var backoffMin: Duration = .seconds(3)
        public var backoffMax: Duration = .seconds(30)
        public var failuresBeforePolling = 2
        public var pollForeground: Duration = .seconds(2)
        public var pollBackground: Duration = .seconds(30)
        public var projectTokens: Duration = .seconds(30)
        public var ticker: Duration = .seconds(1)
        /// How often a device that needs re-pairing is tried again.
        public var repairProbe: Duration = .seconds(60)

        public init() {}
    }

    public nonisolated let record: DeviceRecord
    public nonisolated let api: any DaemonAPI
    private let events: @Sendable () -> AsyncStream<StreamItem>
    private let clock: any Clock
    private let timing: Timing
    private let currentAddr: @Sendable () -> String?

    private var reducer: DeviceReducer
    private var tasks: [Task<Void, Never>] = []
    private var pollTask: Task<Void, Never>?
    private var foreground = true
    private var observers: [UUID: AsyncStream<DeviceState>.Continuation] = [:]

    public init(
        record: DeviceRecord,
        api: any DaemonAPI,
        events: @escaping @Sendable () -> AsyncStream<StreamItem>,
        burn: BurnHistory,
        clock: any Clock = SystemClock(),
        timing: Timing = Timing(),
        currentAddr: @escaping @Sendable () -> String? = { nil }
    ) {
        self.record = record
        self.api = api
        self.events = events
        self.clock = clock
        self.timing = timing
        self.currentAddr = currentAddr
        reducer = DeviceReducer(record: record, burn: burn)
    }

    /// The production wiring: one pinned `URLSession` and one candidate list shared by REST and SSE.
    public static func live(config: DeviceConfig, burn: BurnHistory, clock: any Clock = SystemClock()) -> DeviceClient {
        let session = PinnedTrust.session(fingerprint: config.record.fingerprint)
        let endpoints = Endpoints(record: config.record)
        let api = URLSessionDaemonAPI(config: config, session: session, endpoints: endpoints)
        let stream = EventStream(config: config, session: session, endpoints: endpoints)
        return DeviceClient(
            record: config.record,
            api: api,
            events: { stream.connect() },
            burn: burn,
            clock: clock,
            currentAddr: { endpoints.current?.host() }
        )
    }

    public var state: DeviceState {
        reducer.state
    }

    /// Every state change, starting with the current state. Ends when the caller stops iterating.
    public func states() -> AsyncStream<DeviceState> {
        let (stream, continuation) = AsyncStream<DeviceState>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        observers[id] = continuation
        continuation.yield(reducer.state)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeObserver(id) }
        }
        return stream
    }

    public func start() {
        guard tasks.isEmpty else { return }
        tasks = [
            Task { [weak self] in await self?.connectionLoop() },
            Task { [weak self] in await self?.agingLoop() },
            Task { [weak self] in await self?.projectTokensLoop() },
        ]
    }

    public func stop() {
        stopPolling()
        tasks.forEach { $0.cancel() }
        tasks = []
        mutate { $0.setTransport(.disconnected) }
    }

    /// Foreground polls fast, background slow (the deck's screen-on/off rule).
    public func setForeground(_ value: Bool) {
        foreground = value
    }

    /// One REST pass: health, summary, sessions, rules and project tokens. Used when there is no
    /// stream (background refresh, a watch `{refresh}`) and as the bootstrap before SSE opens.
    public func refresh() async {
        var reachable = false
        if let health = await attempt({ try await self.api.health() }) {
            mutate { $0.applyHealth(health) }
            reachable = true
        }
        if let summary = await attempt({ try await self.api.summary() }) {
            mutate { $0.applySummary(summary, now: clock.now()) }
            reachable = true
        }
        await pollSessions()
        if let rules = await attempt({ try await self.api.rules() }) {
            mutate { $0.applyRules(rules) }
        }
        await refreshProjectTokens()
        if reachable {
            mutate { $0.touch(now: clock.now()) }
        }
    }

    /// `GET /v1/tokens?since=today&groupBy=project`; failures land in `lastError`.
    public func refreshProjectTokens() async {
        if let tokens = await attempt({ try await self.api.tokensByProjectToday() }) {
            mutate { $0.applyTokens(tokens) }
        }
    }

    // MARK: - loops

    private func connectionLoop() async {
        var failures = 0
        var backoff = timing.backoffMin
        while !Task.isCancelled {
            var opened = false
            for await item in events() {
                switch item {
                case .open:
                    opened = true
                    stopPolling()
                    mutate { $0.opened(now: clock.now()) }
                case let .event(event):
                    let refetch = mutateReturning { $0.apply(event, now: clock.now()) }
                    if refetch {
                        Task { await self.pollSessions(ifNoneMatch: nil) }
                    }
                case let .closed(error):
                    mutate { $0.closed(error: error, polling: pollTask != nil) }
                }
            }
            if Task.isCancelled {
                return
            }
            if opened {
                failures = 0
                backoff = timing.backoffMin
            } else {
                failures += 1
            }
            if reducer.state.needsRepair {
                // Retrying faster cannot help: only a re-pair (or a restored token) can.
                stopPolling()
                try? await Task.sleep(for: timing.repairProbe)
                continue
            }
            if failures >= timing.failuresBeforePolling {
                startPolling()
            }
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, timing.backoffMax)
        }
    }

    private func agingLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: timing.ticker)
            mutate { $0.age(now: clock.now()) }
        }
    }

    private func projectTokensLoop() async {
        while !Task.isCancelled {
            if !reducer.state.needsRepair {
                await refreshProjectTokens()
            }
            try? await Task.sleep(for: timing.projectTokens)
        }
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await poll()
                if await reducer.state.needsRepair {
                    // The connection loop's slow probe takes over from here.
                    await pollEnded()
                    return
                }
                let interval = await pollInterval
                try? await Task.sleep(for: interval)
            }
        }
        mutate { $0.setTransport(.polling) }
    }

    private var pollInterval: Duration {
        foreground ? timing.pollForeground : timing.pollBackground
    }

    private func pollEnded() {
        pollTask = nil
        mutate { $0.setTransport(.disconnected) }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func poll() async {
        var reachable = false
        if let summary = await attempt({ try await self.api.summary() }) {
            mutate { $0.applySummary(summary, now: clock.now()) }
            reachable = true
        }
        if await pollSessions() {
            reachable = true
        }
        if reachable {
            mutate { $0.touch(now: clock.now()) }
        }
    }

    @discardableResult
    private func pollSessions() async -> Bool {
        await pollSessions(ifNoneMatch: reducer.etag)
    }

    @discardableResult
    private func pollSessions(ifNoneMatch: String?) async -> Bool {
        guard let result = await attempt({ try await self.api.sessions(ifNoneMatch: ifNoneMatch) }) else { return false }
        mutate { $0.applySessions(result, now: clock.now()) }
        return true
    }

    // MARK: - state plumbing

    private func attempt<T: Sendable>(_ call: @Sendable () async throws -> T) async -> T? {
        do {
            return try await call()
        } catch is CancellationError {
            return nil
        } catch {
            let mapped = DaemonError.from(transport: error)
            mutate { $0.fail(mapped) }
            return nil
        }
    }

    private func mutate(_ change: (inout DeviceReducer) -> Void) {
        _ = mutateReturning { reducer in
            change(&reducer)
            return false
        }
    }

    private func mutateReturning<T>(_ change: (inout DeviceReducer) -> T) -> T {
        let before = reducer.state
        let result = change(&reducer)
        let addr = currentAddr()
        if reducer.state.activeAddr != addr {
            reducer.setActiveAddr(addr)
        }
        if reducer.state != before {
            for continuation in observers.values {
                continuation.yield(reducer.state)
            }
        }
        return result
    }

    private func removeObserver(_ id: UUID) {
        observers[id] = nil
    }
}
