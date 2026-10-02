import Foundation

public enum AlertKind: String, Codable, Sendable {
    case warn = "WARN"
    case critical = "CRITICAL"
    case frozen = "FROZEN"
    case unreachable = "UNREACHABLE"
    /// The device stopped accepting this iPhone (token rotated, certificate regenerated).
    case repair = "REPAIR"
}

/// `key` is the dedupe key: `"KIND|userKey|limitId"`, `"KIND|deviceId"` or `"KIND|deviceId|sessionId"`.
public struct Alert: Codable, Sendable, Equatable {
    public var kind: AlertKind
    public var key: String
    public var title: String
    public var body: String
    /// For a limit alert, the window this crossing belongs to: the limit's `resetsAt` in epoch
    /// milliseconds (nil when the daemon does not say). The once-per-window gate keys on it.
    /// Event-like alerts (frozen, unreachable) carry none.
    public var window: Int64?

    public init(kind: AlertKind, key: String, title: String, body: String, window: Int64? = nil) {
        self.kind = kind
        self.key = key
        self.title = title
        self.body = body
        self.window = window
    }
}

public struct AlertThresholds: Codable, Sendable, Equatable {
    public var warn: Int
    public var critical: Int

    public init(warn: Int = 80, critical: Int = 95) {
        self.warn = warn
        self.critical = critical
    }
}

/// Pure diff of two merged team states. Quiet hours and the once-per-window gate
/// (`AlertLedger`) are the caller's business; this only reports what has just changed.
public struct AlertEvaluator: Sendable {
    public var thresholds: AlertThresholds
    public var timeZone: TimeZone
    /// The app's own renames; defaults to the daemon's display name.
    public var nameFor: @Sendable (UserView) -> String

    public init(
        thresholds: AlertThresholds = AlertThresholds(),
        timeZone: TimeZone = .current,
        nameFor: @escaping @Sendable (UserView) -> String = { $0.displayName }
    ) {
        self.thresholds = thresholds
        self.timeZone = timeZone
        self.nameFor = nameFor
    }

    public func evaluate(previous: TeamState?, next: TeamState) -> [Alert] {
        limitAlerts(previous, next) + frozenAlerts(previous, next) + unreachableAlerts(previous, next)
            + repairAlerts(previous, next)
    }

    /// Limits that are now under the warn threshold: their ledger keys should be forgotten so a
    /// real re-crossing announces itself again.
    public func cleared(_ next: TeamState) -> [String] {
        next.users.flatMap { user in
            user.limits.flatMap { limit -> [String] in
                var keys: [String] = []
                if limit.percent < thresholds.critical {
                    keys.append(limitKey(.critical, user, limit))
                }
                if limit.percent < thresholds.warn {
                    keys.append(limitKey(.warn, user, limit))
                }
                return keys
            }
        }
    }

    private func limitAlerts(_ previous: TeamState?, _ next: TeamState) -> [Alert] {
        let before = Dictionary(previous?.users.map { ($0.key, $0) } ?? [], uniquingKeysWith: { a, _ in a })
        return next.users.flatMap { user -> [Alert] in
            let previousLimits = Dictionary(
                before[user.key]?.limits.map { ($0.id, $0.percent) } ?? [],
                uniquingKeysWith: { a, _ in a }
            )
            return user.limits.compactMap { limit -> Alert? in
                let was = previousLimits[limit.id]
                if crossed(was, limit.percent, thresholds.critical) {
                    return alert(.critical, user, limit, "Usage critical")
                }
                if crossed(was, limit.percent, thresholds.warn), limit.percent < thresholds.critical {
                    return alert(.warn, user, limit, "Usage warning")
                }
                return nil
            }
        }
    }

    /// True when the limit has just reached `threshold`, including the first time we see it.
    private func crossed(_ was: Int?, _ now: Int, _ threshold: Int) -> Bool {
        now >= threshold && (was.map { $0 < threshold } ?? true)
    }

    private func limitKey(_ kind: AlertKind, _ user: UserView, _ limit: Limit) -> String {
        "\(kind.rawValue)|\(user.key)|\(limit.id)"
    }

    private func alert(_ kind: AlertKind, _ user: UserView, _ limit: Limit, _ title: String) -> Alert {
        Alert(
            kind: kind,
            key: limitKey(kind, user, limit),
            title: title,
            body: "\(nameFor(user)) \(Self.label(limit)) at \(limit.percent)% · \(resetText(limit))",
            window: limit.resetsAt.map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) }
        )
    }

    public static func label(_ limit: Limit) -> String {
        switch limit.id {
        case LimitID.session: "5-hour"
        case LimitID.weeklyAll: "7-day"
        default: limit.scopeModel ?? limit.id
        }
    }

    private func resetText(_ limit: Limit) -> String {
        guard let at = limit.resetsAt else { return "resets: unknown" }
        return "resets \(Format.pattern("EEE HH:mm", at, timeZone: timeZone, locale: Locale(identifier: "en_US_POSIX")))"
    }

    private func frozenAlerts(_ previous: TeamState?, _ next: TeamState) -> [Alert] {
        next.devices.flatMap { device -> [Alert] in
            let before = Dictionary(
                previous?.device(device.id)?.sessions.map { ($0.sessionId, $0) } ?? [],
                uniquingKeysWith: { a, _ in a }
            )
            return device.sessions
                .filter { $0.pause?.mode == .hard && before[$0.sessionId]?.pause?.mode != .hard }
                .map { session in
                    Alert(
                        kind: .frozen,
                        key: "\(AlertKind.frozen.rawValue)|\(device.id)|\(session.sessionId)",
                        title: "Session frozen",
                        body: "\(session.projectName) on \(device.displayName) is hard-frozen"
                    )
                }
        }
    }

    private func repairAlerts(_ previous: TeamState?, _ next: TeamState) -> [Alert] {
        next.devices.compactMap { device in
            guard let notice = RepairNotice(device), previous?.device(device.id)?.needsRepair == false else { return nil }
            return Alert(
                kind: .repair,
                key: "\(AlertKind.repair.rawValue)|\(device.id)",
                title: "Re-pair \(notice.name)",
                body: "\(notice.title). \(notice.reason)"
            )
        }
    }

    private func unreachableAlerts(_ previous: TeamState?, _ next: TeamState) -> [Alert] {
        next.devices.compactMap { device in
            let was = previous?.device(device.id)?.health
            guard device.health == .dead, was == .fresh || was == .stale else { return nil }
            return Alert(
                kind: .unreachable,
                key: "\(AlertKind.unreachable.rawValue)|\(device.id)",
                title: "Device unreachable",
                body: "\(device.displayName) has not checked in for 2 minutes"
            )
        }
    }
}
