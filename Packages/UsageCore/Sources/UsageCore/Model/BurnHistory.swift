import Foundation
import Synchronization

/// Per-key buffers of (timestamp, cumulative tokens) used to derive burn rates.
///
/// Keys are opaque (`"<deviceId>/s/<sessionId>"`, `"<deviceId>/p/<projectKey>"`, `"<deviceId>/m"`).
/// A cumulative counter that goes backwards means the underlying thing restarted, so the key's
/// history is discarded and the new sample becomes the baseline — never a negative rate.
///
/// Samples arrive from each device's stream while SwiftUI reads rates on the main actor, so
/// every method takes the same lock and readers work on a copy of the key's points. (Dropping
/// the lock crashed the Android deck every few minutes.)
public final class BurnHistory: Sendable {
    public struct Point: Sendable, Equatable {
        public var at: Date
        public var cumulative: Int64
    }

    private let retention: TimeInterval
    private let maxPoints: Int
    private let points = Mutex<[String: [Point]]>([:])

    public init(retention: TimeInterval = 5 * 3600, maxPoints: Int = 2000) {
        self.retention = retention
        self.maxPoints = maxPoints
    }

    public func record(_ key: String, at: Date, cumulative: Int64) {
        points.withLock { all in
            var list = all[key] ?? []
            if let last = list.last, cumulative < last.cumulative {
                list.removeAll()
            }
            list.append(Point(at: at, cumulative: cumulative))
            let cutoff = at.addingTimeInterval(-retention)
            if let keep = list.firstIndex(where: { $0.at >= cutoff }), keep > 0 {
                list.removeFirst(keep)
            }
            if list.count > maxPoints {
                list.removeFirst(list.count - maxPoints)
            }
            all[key] = list
        }
    }

    /// How far back a row's rate looks. Five minutes, not one: a session thinking between tool
    /// calls reads as busy rather than dropping to 0/min, and the rows ranked by it hold still.
    public static let rateWindow: TimeInterval = 5 * 60

    /// Tokens per minute between the first and last sample inside `window` ending at `now`.
    public func ratePerMinute(_ key: String, now: Date, window: TimeInterval = rateWindow) -> Double {
        let from = now.addingTimeInterval(-window)
        let inWindow = snapshot(key).filter { $0.at >= from && $0.at <= now }
        guard let first = inWindow.first, let last = inWindow.last, inWindow.count >= 2 else { return 0 }
        let seconds = last.at.timeIntervalSince(first.at).rounded(.down)
        guard seconds > 0 else { return 0 }
        return Double(last.cumulative - first.cumulative) / seconds * 60
    }

    /// Tokens/min per bucket over `window` ending at `now`, oldest first; 0 where nothing is known.
    public func series(_ key: String, now: Date, window: TimeInterval, buckets: Int) -> [Double] {
        guard buckets > 0 else { return [] }
        let list = snapshot(key)
        let bucketSeconds = window / Double(buckets)
        guard !list.isEmpty, bucketSeconds > 0 else { return Array(repeating: 0, count: buckets) }
        let start = now.addingTimeInterval(-window)
        return (0 ..< buckets).map { i in
            let bucketStart = start.addingTimeInterval(Double(i) * bucketSeconds)
            let bucketEnd = start.addingTimeInterval(Double(i + 1) * bucketSeconds)
            guard let from = list.last(where: { $0.at <= bucketStart }),
                  let to = list.last(where: { $0.at <= bucketEnd }),
                  to.cumulative > from.cumulative
            else { return 0 }
            return Double(to.cumulative - from.cumulative) / bucketSeconds * 60
        }
    }

    public func forget(_ key: String) {
        _ = points.withLock { $0.removeValue(forKey: key) }
    }

    /// Drops every key that starts with `prefix` (a removed device's `"<deviceId>/"`).
    public func forget(prefix: String) {
        points.withLock { all in
            for key in all.keys where key.hasPrefix(prefix) {
                all.removeValue(forKey: key)
            }
        }
    }

    private func snapshot(_ key: String) -> [Point] {
        points.withLock { $0[key] ?? [] }
    }
}
