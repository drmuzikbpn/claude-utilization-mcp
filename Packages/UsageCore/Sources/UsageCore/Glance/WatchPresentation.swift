import Foundation

/// The watch's copy and pause grammar, kept here so it is tested on the Mac.
public extension WatchSnapshot {
    /// `today 4.2M · 3 live`.
    var footer: String {
        "today \(Format.tokens(teamTodayTokens)) · \(liveSessionCount) live"
    }

    /// `iPhone not reachable · updated 4m ago`; the age is the snapshot's, never hidden.
    func unreachableBanner(now: Date) -> String {
        "iPhone not reachable · updated \(Format.age(generatedAt == .distantPast ? nil : generatedAt, now: now))"
    }

    /// Live projects first, idle ones after, each group in the iPhone's order.
    var projectsLiveFirst: [Project] {
        projects.filter(\.isLive) + projects.filter { !$0.isLive }
    }

    /// A project's share of the team's tokens today, in whole percent; nil before any spend.
    func share(of project: Project) -> Int? {
        guard teamTodayTokens > 0, let today = project.todayTokens else { return nil }
        return Int((Double(today) / Double(teamTodayTokens) * 100).rounded())
    }

    func device(id: String) -> Device? {
        devices.first { $0.id == id }
    }

    /// Whether a pause control for `target` can act: its device is reachable and paired. `.all`
    /// needs at least one such device.
    func canControl(_ target: PauseTarget) -> Bool {
        let usable = { (d: Device) in d.health != .dead && !d.needsRepair }
        guard let deviceId = target.deviceId else { return devices.contains(where: usable) }
        return device(id: deviceId).map(usable) ?? false
    }

    /// The soft→hard escalation waiting on `target`, if one is.
    func escalation(for target: PauseTarget) -> Escalation? {
        escalations.first { $0.scope == target.scope && (target.deviceId == nil || $0.deviceId == target.deviceId) }
    }

    /// The pause standing on `target` as this snapshot reports it. `.all` has no single mode:
    /// any `all` rule on a live device reads as `.soft`.
    func pauseMode(for target: PauseTarget) -> PauseMode? {
        switch target {
        case .all:
            return allPaused ? .soft : nil
        case let .project(deviceId, projectKey):
            return projects.first { $0.deviceId == deviceId && $0.key == projectKey }?.pause
        case let .session(deviceId, sessionId):
            return projects.lazy
                .filter { $0.deviceId == deviceId }
                .compactMap { $0.sessions.first { $0.id == sessionId } }
                .first?.pause
        }
    }

    /// Whether this snapshot already shows `expected` on `target`, so an optimistic flip can
    /// give way to the real state. `.all` compares paused against not paused only.
    func reflects(_ expected: PauseMode?, on target: PauseTarget) -> Bool {
        let actual = pauseMode(for: target)
        if case .all = target {
            return (actual == nil) == (expected == nil)
        }
        return actual == expected
    }

    /// The escalation that fires first, for the Actions page countdown.
    var nextEscalation: Escalation? {
        escalations.min { $0.fireAt < $1.fireAt }
    }
}

public extension WatchSnapshot.Project {
    /// The snapshot only carries live sessions, so any session row means the project is live.
    var isLive: Bool {
        !sessions.isEmpty
    }
}

public extension WatchSnapshot.SessionRow {
    func target(deviceId: String) -> PauseTarget {
        .session(deviceId: deviceId, sessionId: id)
    }
}

public enum PauseGesture: Sendable, Equatable {
    case tap
    /// A long press the user then confirmed with "Freeze?".
    case hold
}

/// The pause grammar (D7): tap = soft, hold → "Freeze?" → hard, tap on paused = resume.
public enum PauseGrammar {
    /// The request a gesture sends; nil when it has nothing to do (holding on something already
    /// frozen, or freezing a session without a hook-registered pid).
    public static func request(
        _ gesture: PauseGesture,
        current: PauseMode?,
        target: PauseTarget,
        canHardPause: Bool = true
    ) -> WatchRequest? {
        switch (gesture, current) {
        case (.tap, nil): .pause(target, mode: .soft)
        case (.tap, _?): .resume(target)
        case (.hold, .hard?): nil
        case (.hold, _): canHardPause ? .pause(target, mode: .hard) : nil
        }
    }

    /// The pause state a request leads to, for the optimistic flip; nil for a resume.
    public static func expected(after request: WatchRequest) -> PauseMode? {
        switch request {
        case let .pause(_, mode): mode
        case .resume, .refresh: nil
        }
    }

    /// The failure line under a control, from the iPhone's per-device outcomes; nil when every
    /// device took it. A partial `all` reads `paused 2 of 3`.
    public static func failure(of request: WatchRequest, outcomes: [PauseOutcome]) -> String? {
        let failed = outcomes.filter { !$0.ok }
        guard let first = failed.first else { return nil }
        let succeeded = outcomes.count - failed.count
        if succeeded > 0 {
            return "\(verb(request)) \(succeeded) of \(outcomes.count)"
        }
        return first.error ?? "\(noun(request)) failed"
    }

    static func noun(_ request: WatchRequest) -> String {
        switch request {
        case .pause(_, mode: .soft): "pause"
        case .pause(_, mode: .hard): "freeze"
        case .resume: "resume"
        case .refresh: "refresh"
        }
    }

    static func verb(_ request: WatchRequest) -> String {
        switch request {
        case .pause(_, mode: .soft): "paused"
        case .pause(_, mode: .hard): "frozen"
        case .resume: "resumed"
        case .refresh: "refreshed"
        }
    }
}
