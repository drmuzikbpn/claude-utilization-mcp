import Foundation
import os
import Synchronization

/// A short on-device diary of what the app did: pairing attempts, addresses that stopped
/// answering, health changes, alerts. It exists so a tester can send it over when something goes
/// wrong; it stays on the iPhone until they share it from Settings.
///
/// Callers write the lines, so the rule is theirs to keep: never an access credential, a pairing
/// code or a certificate fingerprint. Errors go in through `describe`, which keeps only codes.
public final class DiagLog: Sendable {
    public static let shared = DiagLog()

    public enum Category: String, Sendable {
        case app, pairing, network, device, alerts
    }

    private struct State {
        var lines: [String] = []
        /// The newest line without its repeat count, and how often it has repeated.
        var last: String?
        var repeats = 1
        var file: URL?
    }

    private let state = Mutex(State())
    private let limit: Int
    private let mirror: Bool
    private let clock: @Sendable () -> Date
    private let style: Date.ISO8601FormatStyle

    public init(
        limit: Int = 800,
        mirror: Bool = true,
        clock: @escaping @Sendable () -> Date = { Date() },
        timeZone: TimeZone = .current
    ) {
        self.limit = limit
        self.mirror = mirror
        self.clock = clock
        style = Date.ISO8601FormatStyle(timeZone: timeZone)
    }

    /// Keeps the diary in `file` from now on, in front of whatever an earlier launch left there.
    public func attach(file: URL) {
        let earlier = (try? String(contentsOf: file, encoding: .utf8))?
            .split(separator: "\n").map(String.init) ?? []
        state.withLock { s in
            s.file = file
            s.lines = Array((earlier + s.lines).suffix(limit))
            persist(s)
        }
    }

    public func log(_ category: Category, _ message: String) {
        let entry = "\(category.rawValue) \(message)"
        if mirror {
            Logger(subsystem: "com.evenseal.usagedeck", category: category.rawValue)
                .notice("\(message, privacy: .public)")
        }
        state.withLock { s in
            if s.last == entry, let newest = s.lines.indices.last {
                // Same thing again (an address that stays down): count it, and leave the file
                // alone until something new happens.
                s.repeats += 1
                let stamp = s.lines[newest].prefix { $0 != " " }
                s.lines[newest] = "\(stamp) \(entry) ×\(s.repeats)"
                return
            }
            if s.repeats > 1 {
                persist(s)
            }
            s.last = entry
            s.repeats = 1
            s.lines.append("\(clock().formatted(style)) \(entry)")
            if s.lines.count > limit {
                s.lines.removeFirst(s.lines.count - limit)
            }
            persist(s)
        }
    }

    public func lines() -> [String] {
        state.withLock { $0.lines }
    }

    public var text: String {
        lines().joined(separator: "\n")
    }

    /// Writes any repeat counts still only in memory (the app is about to be suspended).
    public func flush() {
        state.withLock { persist($0) }
    }

    public func clear() {
        state.withLock { s in
            s.lines = []
            s.last = nil
            s.repeats = 1
            persist(s)
        }
    }

    private func persist(_ s: State) {
        guard let file = s.file else { return }
        try? Data(s.lines.joined(separator: "\n").utf8).write(to: file, options: .atomic)
    }

    /// An error as its code alone. Messages and hints can quote what the user typed or what a
    /// device sent, so they never go into the diary.
    public static func describe(_ error: any Error) -> String {
        if let daemon = error as? DaemonError {
            return daemon.httpStatus == 0 ? daemon.code : "\(daemon.code) (HTTP \(daemon.httpStatus))"
        }
        if let url = error as? URLError {
            return "URLError \(url.code.rawValue)"
        }
        return String(describing: type(of: error))
    }
}
