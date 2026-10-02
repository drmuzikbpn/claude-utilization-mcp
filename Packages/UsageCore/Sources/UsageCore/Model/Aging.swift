import Foundation

/// Heartbeat aging: fresh under 30 s, stale under 2 min, dead at or past 2 min (deck spec §7).
public enum Aging {
    public static let fresh: TimeInterval = 30
    public static let dead: TimeInterval = 120

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
}
