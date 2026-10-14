// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import os
import Synchronization

/// A short on-device diary of what the app did: pairing attempts, addresses that stopped
/// answering, health changes, alerts. It exists so a tester can send it over when something goes
/// wrong; it stays on the iPhone until they share it from Settings.
///
/// Callers write the lines, so the rule is theirs to keep: never an access credential, a pairing
/// code or a certificate fingerprint, and never an alert's body (its kind and key say enough).
/// Errors go in through `describe`, which keeps only codes; a device's name goes in through
/// `name(_:)` and an address through `host(_:)`, which clean it and mark it so that an export can
/// leave it out. Whatever is written, a line is one line: control characters become spaces.
///
/// The unified system log gets a copy in Debug builds only.
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
        let message = Self.oneLine(message)
        let entry = "\(category.rawValue) \(message)"
        #if DEBUG
            if mirror {
                Logger(subsystem: "com.evenseal.usagedeck", category: category.rawValue)
                    .notice("\(Self.plain(message), privacy: .public)")
            }
        #endif
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

    /// The diary as the app shows it: marks removed, nothing hidden.
    public func lines() -> [String] {
        state.withLock { $0.lines }.map(Self.plain)
    }

    /// The diary as it leaves the iPhone. `redacting` (the default) replaces every device name
    /// with `device-N` and every address or host name with `host-N` (the same N for the same
    /// value, so the story still reads), and any address nobody marked with `<address>`/`<host>`.
    public func export(redacting: Bool = true) -> String {
        let raw = state.withLock { $0.lines }
        guard redacting else { return raw.map(Self.plain).joined(separator: "\n") }
        var redactor = Redactor()
        return raw.map { redactor.redact($0) }.joined(separator: "\n")
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
        try? Data(s.lines.joined(separator: "\n").utf8)
            .write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// An error as its code alone. Messages and hints can quote what the user typed or what a
    /// device sent, so they never go into the diary.
    public static func describe(_ error: any Error) -> String {
        if let daemon = error as? DaemonError {
            let code = safeCode(daemon.code)
            return daemon.httpStatus == 0 ? code : "\(code) (HTTP \(daemon.httpStatus))"
        }
        if let url = error as? URLError {
            return "URLError \(url.code.rawValue)"
        }
        return String(describing: type(of: error))
    }

    /// A daemon chooses its error `code`, so only something shaped like one is written:
    /// `[a-z0-9_]{1,40}`. Anything else is `unknown`.
    public static func safeCode(_ code: String) -> String {
        let shaped = (1 ... 40).contains(code.utf8.count) && code.utf8.allSatisfy { byte in
            (UInt8(ascii: "a") ... UInt8(ascii: "z")).contains(byte)
                || (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains(byte)
                || byte == UInt8(ascii: "_")
        }
        return shaped ? code : "unknown"
    }

    /// An alert's dedupe key (`KIND|id|id`) for a log line. Each part is written only when it is
    /// shaped like an identifier (letters, digits, `_`, `-`, `/`; at most 80 characters): an
    /// account without a UUID is keyed by its e-mail address, and that is left out.
    public static func safeKey(_ key: String) -> String {
        key.split(separator: "|", omittingEmptySubsequences: false).map { part -> String in
            let shaped = (1 ... 80).contains(part.utf8.count) && part.utf8.allSatisfy { byte in
                (UInt8(ascii: "a") ... UInt8(ascii: "z")).contains(byte)
                    || (UInt8(ascii: "A") ... UInt8(ascii: "Z")).contains(byte)
                    || (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains(byte)
                    || byte == UInt8(ascii: "_") || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "/")
            }
            return shaped ? String(part) : "…"
        }.joined(separator: "|")
    }

    // MARK: - names and addresses

    private static let nameMark: Unicode.Scalar = "\u{E000}"
    private static let hostMark: Unicode.Scalar = "\u{E001}"
    private static let endMark: Unicode.Scalar = "\u{E002}"

    /// A device or invite name for a log line: cleaned (`DeviceName.clean`) and marked.
    public static func name(_ raw: String) -> String {
        "\(nameMark)\(DeviceName.clean(raw))\(endMark)"
    }

    /// An address or host name for a log line: cleaned and marked.
    public static func host(_ raw: String) -> String {
        "\(hostMark)\(String(DeviceName.clean(raw).prefix(253)))\(endMark)"
    }

    /// `text` without the marks `name` and `host` put in.
    public static func plain(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { $0 != nameMark && $0 != hostMark && $0 != endMark }))
    }

    /// Control characters and line separators as spaces, so nothing written can start a new line.
    static func oneLine(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.map { scalar in
            switch scalar.properties.generalCategory {
            case .control, .lineSeparator, .paragraphSeparator: " "
            default: scalar
            }
        }))
    }

    /// One export's worth of pseudonyms.
    private struct Redactor {
        private var names: [String: Int] = [:]
        private var hosts: [String: Int] = [:]

        mutating func redact(_ line: String) -> String {
            // The timestamp is ours; only what follows it is searched.
            let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { return unmarked(line) }
            return "\(parts[0]) \(unmarked(marked(String(parts[1]))))"
        }

        private mutating func marked(_ text: String) -> String {
            var out = String.UnicodeScalarView()
            var held = String.UnicodeScalarView()
            var open: Unicode.Scalar?
            for scalar in text.unicodeScalars {
                switch scalar {
                case DiagLog.nameMark, DiagLog.hostMark:
                    open = scalar
                    held = String.UnicodeScalarView()
                case DiagLog.endMark:
                    if let mark = open {
                        out.append(contentsOf: pseudonym(String(held), isName: mark == DiagLog.nameMark).unicodeScalars)
                    }
                    open = nil
                default:
                    if open == nil {
                        out.append(scalar)
                    } else {
                        held.append(scalar)
                    }
                }
            }
            return String(out)
        }

        private mutating func pseudonym(_ value: String, isName: Bool) -> String {
            let key = value.lowercased()
            if isName {
                let n = names[key] ?? names.count + 1
                names[key] = n
                return "device-\(n)"
            }
            let n = hosts[key] ?? hosts.count + 1
            hosts[key] = n
            return "host-\(n)"
        }

        /// Addresses and dotted host names that reached a line without a mark.
        private func unmarked(_ text: String) -> String {
            let ipv6 = /(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f:]*/
            let ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
            let host = /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z][A-Za-z0-9-]*\b/
            return text
                .replacing(ipv6, with: "<address>")
                .replacing(ipv4, with: "<address>")
                .replacing(host, with: "<host>")
        }
    }
}
