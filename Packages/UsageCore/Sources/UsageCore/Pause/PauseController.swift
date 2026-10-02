import Foundation
import Observation

public struct PauseOutcome: Codable, Sendable, Equatable {
    public var deviceId: String
    public var ok: Bool
    public var error: String?

    public init(deviceId: String, ok: Bool, error: String?) {
        self.deviceId = deviceId
        self.ok = ok
        self.error = error
    }
}

/// Issues pause/resume against the right devices and runs the soft→hard escalation timer.
///
/// Only rules whose `reason` equals this install's `usage-deck:<installId>` are ours: a soft
/// pause started from the CLI, the Android deck or another phone never escalates here.
/// Escalation is best-effort on iOS (D10): it runs while an app is awake, and `tick()` on wake
/// fires anything that came due while suspended.
@MainActor
@Observable
public final class PauseController {
    public let reason: String
    public private(set) var pending: [Escalation] = []
    public private(set) var inFlight: Set<String> = []
    /// Per-device results of the last `.all` action, for the "paused 2 of 3" banner.
    public private(set) var lastOutcomes: [PauseOutcome] = []

    @ObservationIgnored private let team: @MainActor () -> TeamState
    @ObservationIgnored private let apis: @MainActor (String) -> (any DaemonAPI)?
    @ObservationIgnored private let store: any EscalationStore
    @ObservationIgnored private let clock: any Clock
    /// Seconds before a soft pause escalates; nil turns escalation off (deck default 90).
    @ObservationIgnored private let escalationSeconds: @MainActor () -> Int?
    @ObservationIgnored private let retryDelay: Duration
    /// Escalation keys whose rule we have actually seen; only those are cancelled by its absence.
    @ObservationIgnored private var observed: Set<String> = []
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var loaded = false

    public init(
        team: @escaping @MainActor () -> TeamState,
        apis: @escaping @MainActor (String) -> (any DaemonAPI)?,
        installId: String,
        store: any EscalationStore,
        clock: any Clock = SystemClock(),
        escalationSeconds: @escaping @MainActor () -> Int? = { 90 },
        retryDelay: Duration = .seconds(2)
    ) {
        reason = "usage-deck:\(installId)"
        self.team = team
        self.apis = apis
        self.store = store
        self.clock = clock
        self.escalationSeconds = escalationSeconds
        self.retryDelay = retryDelay
    }

    /// Loads persisted escalations and ticks every `interval` until `stop()`.
    public func start(interval: Duration = .seconds(1)) {
        loadIfNeeded()
        guard timer == nil else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: interval)
            }
        }
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    // MARK: - gestures

    /// Tap: resume when paused, soft pause otherwise.
    @discardableResult
    public func tap(_ target: PauseTarget) async -> [PauseOutcome] {
        isPaused(target) ? await resume(target) : await soft(target)
    }

    /// Hold (after the "Freeze?" confirm): hard freeze.
    @discardableResult
    public func hold(_ target: PauseTarget) async -> [PauseOutcome] {
        await hard(target)
    }

    @discardableResult
    public func soft(_ target: PauseTarget) async -> [PauseOutcome] {
        await act(target, mode: .soft)
    }

    @discardableResult
    public func hard(_ target: PauseTarget) async -> [PauseOutcome] {
        await act(target, mode: .hard)
    }

    /// Lifts the target's own rule and, for a project, every session rule under it. Daemons from
    /// 0.1.66 cascade a project resume themselves; older ones resume exactly the scope given, and
    /// a project shows paused whenever any of its sessions is. Resuming a lifted scope is a no-op,
    /// so the fan-out is harmless on both.
    @discardableResult
    public func resume(_ target: PauseTarget) async -> [PauseOutcome] {
        loadIfNeeded()
        let own = target.scope
        var outcomes: [PauseOutcome] = []
        for deviceId in targetDevices(target) {
            let scopes = [own] + nestedPausedScopes(deviceId: deviceId, target: target)
            let outcome = await withInFlight(deviceId, own) { () async -> PauseOutcome in
                guard let api = apis(deviceId) else { return networkOutcome(deviceId) }
                // Every scope gets its call: one refusal must not leave the rest standing, and
                // an escalation is only dropped once its scope has really been lifted.
                var ownFailure: DaemonError?
                for scope in scopes {
                    if let failure = await resumeFailure(api, scope) {
                        if scope == own {
                            ownFailure = failure
                        }
                    } else {
                        cancelEscalation(deviceId: deviceId, scope: scope)
                    }
                }
                return PauseOutcome(deviceId: deviceId, ok: ownFailure == nil, error: ownFailure?.userMessage)
            }
            outcomes.append(outcome)
        }
        if target == .all {
            lastOutcomes = outcomes
        }
        return outcomes
    }

    // MARK: - queries

    public func isPaused(_ target: PauseTarget) -> Bool {
        let state = team()
        switch target {
        case let .session(deviceId, sessionId):
            return state.session(deviceId: deviceId, sessionId: sessionId)?.pause != nil
                || hasRule(state.device(deviceId), target.scope)
        case let .project(deviceId, projectKey):
            let sessionPaused = state.device(deviceId)?.sessions
                .contains { $0.projectKey == projectKey && $0.pause != nil } ?? false
            return sessionPaused || hasRule(state.device(deviceId), target.scope)
        case .all:
            return state.devices.contains { hasRule($0, target.scope) }
        }
    }

    public func escalation(for target: PauseTarget) -> Escalation? {
        pending.first { $0.scope == target.scope && (target.deviceId == nil || $0.deviceId == target.deviceId) }
    }

    public func isInFlight(_ target: PauseTarget, deviceId: String) -> Bool {
        inFlight.contains(Self.key(deviceId, target.scope))
    }

    // MARK: - escalation timer

    /// One pass of the escalation timer: drops escalations whose rule was lifted elsewhere and
    /// fires the due ones (hard pause), awaiting them. Call on wake to fire overdue timers at once.
    public func tick() async {
        loadIfNeeded()
        let now = clock.now()
        var survivors: [Escalation] = []
        var due: [Escalation] = []
        var changed = false
        for escalation in pending {
            let key = Self.key(escalation.deviceId, escalation.scope)
            if isOurRule(deviceId: escalation.deviceId, scope: escalation.scope) {
                observed.insert(key)
            } else if observed.contains(key) {
                // Our rule was resumed elsewhere.
                observed.remove(key)
                changed = true
                continue
            }
            if now < escalation.fireAt {
                survivors.append(escalation)
            } else {
                due.append(escalation)
            }
        }
        guard !due.isEmpty || changed else { return }
        pending = survivors
        store.save(survivors)

        for escalation in due {
            observed.remove(Self.key(escalation.deviceId, escalation.scope))
            guard let device = team().device(escalation.deviceId), device.health != .dead else { continue }
            _ = await pauseOne(deviceId: escalation.deviceId, scope: escalation.scope, mode: .hard, retry: false)
        }
    }

    // MARK: - internals

    private func act(_ target: PauseTarget, mode: PauseMode) async -> [PauseOutcome] {
        loadIfNeeded()
        let scope = target.scope
        let fanOut = target == .all
        let devices = targetDevices(target)
        var results: [String: PauseOutcome] = [:]
        await withTaskGroup(of: PauseOutcome.self) { group in
            for deviceId in devices {
                group.addTask { await self.pauseOne(deviceId: deviceId, scope: scope, mode: mode, retry: fanOut) }
            }
            for await outcome in group {
                results[outcome.deviceId] = outcome
            }
        }
        let outcomes = devices.compactMap { results[$0] }
        if fanOut {
            lastOutcomes = outcomes
        }
        return outcomes
    }

    private func pauseOne(deviceId: String, scope: String, mode: PauseMode, retry: Bool) async -> PauseOutcome {
        if let refused = refusedLocally(deviceId: deviceId, scope: scope, mode: mode) {
            return refused
        }
        guard let api = apis(deviceId) else { return networkOutcome(deviceId) }
        return await withInFlight(deviceId, scope) { () async -> PauseOutcome in
            var outcome = await attemptPause(api, deviceId: deviceId, scope: scope, mode: mode)
            if !outcome.ok, retry {
                try? await Task.sleep(for: retryDelay)
                outcome = await attemptPause(api, deviceId: deviceId, scope: scope, mode: mode)
            }
            if outcome.ok, mode == .soft {
                scheduleEscalation(deviceId: deviceId, scope: scope)
            }
            return outcome
        }
    }

    private func attemptPause(_ api: any DaemonAPI, deviceId: String, scope: String, mode: PauseMode) async -> PauseOutcome {
        do {
            _ = try await api.pause(scope: scope, mode: mode, reason: reason)
            return PauseOutcome(deviceId: deviceId, ok: true, error: nil)
        } catch {
            return PauseOutcome(deviceId: deviceId, ok: false, error: DaemonError.from(transport: error).userMessage)
        }
    }

    private func resumeFailure(_ api: any DaemonAPI, _ scope: String) async -> DaemonError? {
        do {
            _ = try await api.resume(scope: scope)
            return nil
        } catch {
            return DaemonError.from(transport: error)
        }
    }

    /// The session scopes under a project target that are paused or carry a rule on `deviceId`.
    private func nestedPausedScopes(deviceId: String, target: PauseTarget) -> [String] {
        guard case let .project(_, projectKey) = target, let device = team().device(deviceId) else { return [] }
        var scopes: [String] = []
        for session in device.sessions where session.projectKey == projectKey {
            let scope = PauseTarget.session(deviceId: deviceId, sessionId: session.sessionId).scope
            if session.pause?.scope == scope || hasRule(device, scope), !scopes.contains(scope) {
                scopes.append(scope)
            }
        }
        return scopes
    }

    /// A hard freeze on a session with no trusted pid is refused here, without asking the daemon.
    private func refusedLocally(deviceId: String, scope: String, mode: PauseMode) -> PauseOutcome? {
        guard mode == .hard, scope.hasPrefix("session:") else { return nil }
        let sessionId = String(scope.dropFirst("session:".count))
        guard let session = team().session(deviceId: deviceId, sessionId: sessionId), !session.canHardPause else { return nil }
        return PauseOutcome(deviceId: deviceId, ok: false, error: DaemonError.defaults["conflict"])
    }

    private func networkOutcome(_ deviceId: String) -> PauseOutcome {
        PauseOutcome(deviceId: deviceId, ok: false, error: DaemonError.defaults["network"])
    }

    private func withInFlight(_ deviceId: String, _ scope: String, _ body: () async -> PauseOutcome) async -> PauseOutcome {
        let key = Self.key(deviceId, scope)
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        return await body()
    }

    private static func key(_ deviceId: String, _ scope: String) -> String {
        "\(deviceId)|\(scope)"
    }

    /// Session and project scopes go to one device; only `.all` fans out, to every device not dead.
    private func targetDevices(_ target: PauseTarget) -> [String] {
        if let deviceId = target.deviceId {
            return [deviceId]
        }
        return team().devices.filter { $0.health != .dead }.map(\.id)
    }

    private func hasRule(_ device: DeviceState?, _ scope: String) -> Bool {
        device?.rules.contains { $0.scope == scope } ?? false
    }

    private func isOurRule(deviceId: String, scope: String) -> Bool {
        team().device(deviceId)?.rules.contains { $0.scope == scope && $0.reason == reason } ?? false
    }

    private func scheduleEscalation(deviceId: String, scope: String) {
        guard let seconds = escalationSeconds() else { return }
        let escalation = Escalation(deviceId: deviceId, scope: scope, fireAt: clock.now().addingTimeInterval(TimeInterval(seconds)))
        pending = pending.filter { !($0.deviceId == deviceId && $0.scope == scope) } + [escalation]
        store.save(pending)
    }

    private func cancelEscalation(deviceId: String, scope: String) {
        observed.remove(Self.key(deviceId, scope))
        let after = pending.filter { !($0.deviceId == deviceId && $0.scope == scope) }
        if after.count != pending.count {
            pending = after
            store.save(after)
        }
    }

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        pending = store.load()
    }
}
