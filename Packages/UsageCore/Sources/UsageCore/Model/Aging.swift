import Foundation

/// Heartbeat aging: fresh under 30 s, stale under 2 min, dead at or past 2 min (deck spec §7).
/// A device that has not checked in for a day is gone: it stays paired, but nothing it last
/// reported is shown any more.
public enum Aging {
    public static let fresh: TimeInterval = 30
    public static let dead: TimeInterval = 120
    public static let gone: TimeInterval = 24 * 3600

    public static func health(lastHeartbeatAt: Date?, now: Date) -> Health {
        guard let lastHeartbeatAt else { return .dead }
        let age = now.timeIntervalSince(lastHeartbeatAt)
        if age < fresh {
            return .fresh
        }
        if age < dead {
            return .stale
        }
        return .dead
    }

    /// A device never heard from is still connecting, not gone: there is nothing of its to drop.
    public static func isGone(lastHeartbeatAt: Date?, now: Date) -> Bool {
        guard let lastHeartbeatAt else { return false }
        return now.timeIntervalSince(lastHeartbeatAt) >= gone
    }
}

public extension DeviceState {
    /// This state on `now`'s clock: health re-derived and, on the tick the device turns
    /// `Aging.gone`, its readings forgotten. Only on that tick, so an answer that lands just
    /// before the heartbeat it proves is not wiped by the next one.
    func aged(now: Date) -> DeviceState {
        var next = self
        next.health = Aging.health(lastHeartbeatAt: lastHeartbeatAt, now: now)
        next.gone = Aging.isGone(lastHeartbeatAt: lastHeartbeatAt, now: now)
        if next.gone, !gone {
            next.limits = []
            next.limitsFetchedAt = nil
            next.today = .zero
            next.sessions = []
            next.rules = []
            next.projectTokens = []
            next.summaryLoaded = false
        }
        return next
    }
}
