import Foundation

/// The app-side gate in front of `AlertEvaluator`.
public enum DeckAlerts {
    /// A device's first state after launch (or a background wake) is not news: a session that was
    /// already frozen must not announce itself every time the app starts. Frozen alerts therefore
    /// pass only for devices that had already arrived in `previous`. Limit alerts always pass
    /// here — `AlertLedger` makes them once per window — and unreachable ones already need a
    /// previous health.
    public static func admissible(_ alerts: [Alert], previous: TeamState?) -> [Alert] {
        alerts.filter { alert in
            guard alert.kind == .frozen else { return true }
            let parts = alert.key.split(separator: "|", omittingEmptySubsequences: false)
            guard parts.count >= 2 else { return false }
            return previous?.device(String(parts[1]))?.hasSnapshot == true
        }
    }
}

/// When a new snapshot is worth sending on.
public enum SnapshotDiff {
    /// Equal apart from when it was generated: no need to wake the watch.
    public static func sameContent(_ a: WatchSnapshot?, _ b: WatchSnapshot) -> Bool {
        guard var a else { return false }
        a.generatedAt = b.generatedAt
        return a == b
    }

    /// Whether `next` should go out: when it differs from what was last sent (only in what a
    /// widget draws, with `headlineOnly`), or when the last one sent is `heartbeat` seconds old.
    /// The receivers age data by `generatedAt`, so an unchanged snapshot still needs re-sending
    /// now and then or current numbers would read as stale.
    public static func isDue(
        last: WatchSnapshot?,
        next: WatchSnapshot,
        heartbeat: TimeInterval,
        headlineOnly: Bool = false
    ) -> Bool {
        guard let last else { return true }
        let same = headlineOnly ? sameHeadline(last, next) : sameContent(last, next)
        return !same || next.generatedAt.timeIntervalSince(last.generatedAt) >= heartbeat
    }

    /// The parts a widget draws: accounts (percent, status, reset, staleness) and device health.
    /// Burn rates and session rows move every second and are not worth a widget reload.
    public static func sameHeadline(_ a: WatchSnapshot?, _ b: WatchSnapshot) -> Bool {
        guard let a else { return false }
        return a.accounts == b.accounts
            && a.devices.map { [$0.id, "\($0.health)", "\($0.needsRepair)"] } == b.devices
            .map { [$0.id, "\($0.health)", "\($0.needsRepair)"] }
            && a.use24h == b.use24h
    }
}
