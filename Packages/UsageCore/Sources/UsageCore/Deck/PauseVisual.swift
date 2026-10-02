import Foundation

/// What a pause control draws right now (deck `PauseVisual`, plus the direction of an in-flight
/// request so the optimistic flip is drawn before the daemon confirms).
public enum PauseVisual: Sendable, Equatable {
    /// Nothing paused: tap soft-pauses, long-press asks "Freeze?".
    case idle
    /// Soft-paused; `countdown` is the escalation countdown (`0:42`), nil when none is pending.
    case soft(countdown: String?)
    /// Hard-frozen; `elapsed` is how long (`2m`).
    case frozen(elapsed: String)
    /// The device is dead: controls do nothing.
    case disabled
    /// A request is on its way; `pausing` is the state it is heading to.
    case inFlight(pausing: Bool)

    public var isPaused: Bool {
        switch self {
        case .soft, .frozen: true
        case .idle, .disabled, .inFlight: false
        }
    }
}

public enum PauseVisuals {
    /// In flight beats everything, then a dead device disables, then the real pause state.
    /// `inFlight` holds `PauseController.inFlight` keys (`"<deviceId>|<scope>"`).
    public static func visual(
        _ target: PauseTarget,
        team: TeamState,
        now: Date,
        inFlight: Set<String> = [],
        escalation: Escalation? = nil
    ) -> PauseVisual {
        let pause = currentPause(target, team: team)
        if isInFlight(target, inFlight) {
            return .inFlight(pausing: pause == nil)
        }
        if isDead(target, team) {
            return .disabled
        }
        guard let pause else { return .idle }
        switch pause.mode {
        case .hard:
            return .frozen(elapsed: elapsed(since: pause.since, now: now))
        case .soft:
            return .soft(countdown: escalation.map { Format.countdown($0.fireAt, now: now) })
        }
    }

    private struct Current {
        var mode: PauseMode
        var since: Date
    }

    /// The pause standing on `target`: a session's own state, a project's most severe session,
    /// or a rule on the scope itself.
    private static func currentPause(_ target: PauseTarget, team: TeamState) -> Current? {
        let scope = target.scope
        switch target {
        case let .session(deviceId, sessionId):
            if let pause = team.session(deviceId: deviceId, sessionId: sessionId)?.pause {
                return Current(mode: pause.mode, since: pause.since)
            }
            return rule(scope, on: team.device(deviceId).map { [$0] } ?? [])
        case let .project(deviceId, projectKey):
            let paused = team.device(deviceId)?.sessions
                .filter { $0.projectKey == projectKey }
                .compactMap(\.pause) ?? []
            if let pause = paused.first(where: { $0.mode == .hard }) ?? paused.first {
                return Current(mode: pause.mode, since: pause.since)
            }
            return rule(scope, on: team.device(deviceId).map { [$0] } ?? [])
        case .all:
            return rule(scope, on: team.devices.filter { $0.health != .dead })
        }
    }

    private static func rule(_ scope: String, on devices: [DeviceState]) -> Current? {
        let rules = devices.flatMap(\.rules).filter { $0.scope == scope }
        guard let rule = rules.first(where: { $0.mode == .hard }) ?? rules.first else { return nil }
        return Current(mode: rule.mode, since: rule.createdAt)
    }

    private static func isInFlight(_ target: PauseTarget, _ keys: Set<String>) -> Bool {
        if let deviceId = target.deviceId {
            return keys.contains("\(deviceId)|\(target.scope)")
        }
        return keys.contains { $0.hasSuffix("|\(target.scope)") }
    }

    private static func isDead(_ target: PauseTarget, _ team: TeamState) -> Bool {
        if let deviceId = target.deviceId {
            return (team.device(deviceId)?.health ?? .dead) == .dead
        }
        return !team.devices.contains { $0.health != .dead }
    }

    private static func elapsed(since: Date, now: Date) -> String {
        let age = Format.age(since, now: now)
        return age.hasSuffix(" ago") ? String(age.dropLast(" ago".count)) : age
    }
}
