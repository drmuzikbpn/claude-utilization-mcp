import Foundation

/// Decides when a lost pairing is announced, across launches and background wakes.
///
/// A device counts as known good once it has answered without needing re-pair; that is
/// persisted. When a known-good device next shows up needing re-pair, it is announced once and
/// stops being known good. A device flapping between the two stays quiet for `cooldown` after
/// an announcement. Re-pairing or removing a device forgets it.
public struct RepairLedger: Sendable {
    public static let prefix = "repair-ledger."
    public static let cooldown: TimeInterval = 3600

    /// UserDefaults is documented thread-safe but not annotated `Sendable`.
    private nonisolated(unsafe) let defaults: UserDefaults
    private let cooldown: TimeInterval

    public init(defaults: UserDefaults, cooldown: TimeInterval = cooldown) {
        self.defaults = defaults
        self.cooldown = cooldown
    }

    /// Records what `team` says and returns the alerts it has earned.
    public func review(_ team: TeamState, now: Date) -> [Alert] {
        team.devices.compactMap { device in
            let key = Self.prefix + device.id
            var entry = defaults.dictionary(forKey: key) ?? [:]
            if let notice = RepairNotice(device) {
                guard entry["good"] as? Bool == true else { return nil }
                entry["good"] = false
                defaults.set(entry, forKey: key)
                if let last = entry["announcedAt"] as? Double, now.timeIntervalSince1970 - last < cooldown {
                    return nil
                }
                entry["announcedAt"] = now.timeIntervalSince1970
                defaults.set(entry, forKey: key)
                return notice.alert
            }
            // Answered and accepted: known good from here on.
            if device.lastHeartbeatAt != nil, entry["good"] as? Bool != true {
                entry["good"] = true
                defaults.set(entry, forKey: key)
            }
            return nil
        }
    }

    public func forget(_ deviceId: String) {
        defaults.removeObject(forKey: Self.prefix + deviceId)
    }
}
