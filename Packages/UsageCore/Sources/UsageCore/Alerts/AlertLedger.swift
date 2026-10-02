import Foundation

/// Remembers which limit alerts have been announced, so each fires **once per window**.
///
/// The evaluator treats a limit it has never seen as a fresh crossing, and the app is relaunched
/// often (and wakes for background refresh), so without this a 7-day window sitting at 96 %
/// would re-announce itself on every launch until the reset. The window's own `resetsAt` is the
/// identity: a new window is a new alert, the same window never speaks twice, and dropping back
/// under the threshold forgets the key so a genuine re-crossing still speaks up.
public struct AlertLedger: Sendable {
    public static let prefix = "alert-ledger."

    /// UserDefaults is documented thread-safe but not annotated `Sendable`.
    private nonisolated(unsafe) let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// True when `key` has not been announced for `window` yet; records it in the same breath.
    public func markFired(_ key: String, window: Int64) -> Bool {
        let stored = Self.prefix + key
        if let previous = defaults.object(forKey: stored) as? NSNumber, previous.int64Value == window {
            return false
        }
        defaults.set(NSNumber(value: window), forKey: stored)
        return true
    }

    /// Forgets `key`, so the next crossing of that threshold announces itself again.
    public func forget(_ key: String) {
        defaults.removeObject(forKey: Self.prefix + key)
    }

    /// The alerts from `alerts` that should actually be shown. Limit alerts pass the ledger;
    /// a limit alert without a window (unknown reset) and event alerts always pass.
    public func admit(_ alerts: [Alert]) -> [Alert] {
        alerts.filter { alert in
            guard let window = alert.window, alert.kind == .warn || alert.kind == .critical else { return true }
            return markFired(alert.key, window: window)
        }
    }
}
