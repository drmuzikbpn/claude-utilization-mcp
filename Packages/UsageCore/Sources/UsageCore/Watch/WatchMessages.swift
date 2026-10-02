import Foundation

/// What the watch asks of the iPhone over `WCSession.sendMessage`.
///
/// `.refresh` is sent every 10 s while the watch app is active; the phone replies at once with
/// its cached snapshot and follows with a fresh one via `updateApplicationContext` (B4).
public enum WatchRequest: Codable, Sendable, Equatable {
    case refresh
    case pause(PauseTarget, mode: PauseMode)
    case resume(PauseTarget)
}

/// The iPhone's reply to a `WatchRequest`.
public struct WatchReply: Codable, Sendable, Equatable {
    /// `WatchSnapshotCodec` bytes, already size-trimmed.
    public var snapshot: Data?
    /// Per-device results of a pause or resume.
    public var outcomes: [PauseOutcome]

    public init(snapshot: Data? = nil, outcomes: [PauseOutcome] = []) {
        self.snapshot = snapshot
        self.outcomes = outcomes
    }
}

/// Packs messages into the property-list dictionaries WatchConnectivity carries.
public enum WatchWire {
    public static let version = 1
    static let versionKey = "v"
    static let bodyKey = "body"
    /// `updateApplicationContext` / `transferCurrentComplicationUserInfo` key for snapshot bytes.
    public static let snapshotKey = "snapshot"

    public static func pack(_ value: some Encodable) throws -> [String: Any] {
        try [versionKey: version, bodyKey: JSONEncoder().encode(value)]
    }

    /// Nil for anything malformed or from a newer wire version.
    public static func unpack<T: Decodable>(_ type: T.Type, from dictionary: [String: Any]) -> T? {
        guard (dictionary[versionKey] as? Int) == version, let body = dictionary[bodyKey] as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: body)
    }

    public static func packSnapshot(_ snapshot: WatchSnapshot) throws -> [String: Any] {
        try [versionKey: version, snapshotKey: WatchSnapshotCodec.encode(snapshot)]
    }

    public static func unpackSnapshot(from dictionary: [String: Any]) -> WatchSnapshot? {
        guard (dictionary[versionKey] as? Int) == version, let data = dictionary[snapshotKey] as? Data else { return nil }
        return try? WatchSnapshotCodec.decode(data)
    }
}

/// Whether a new snapshot is worth one of the day's limited complication transfers (B2):
/// a headline moved by 5 points or more, or changed status, or an account came or went.
public enum ComplicationPolicy {
    public static let minimumDelta = 5

    public static func shouldTransfer(previous: WatchSnapshot?, next: WatchSnapshot) -> Bool {
        guard let previous else { return true }
        let before = Dictionary(previous.accounts.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        if Set(before.keys) != Set(next.accounts.map(\.key)) {
            return true
        }
        for account in next.accounts {
            guard let old = before[account.key] else { return true }
            if moved(old.fiveHour, account.fiveHour) || moved(old.sevenDay, account.sevenDay) {
                return true
            }
        }
        return false
    }

    private static func moved(_ a: WatchSnapshot.Headline?, _ b: WatchSnapshot.Headline?) -> Bool {
        switch (a, b) {
        case (nil, nil): false
        case let (a?, b?): abs(a.percent - b.percent) >= minimumDelta || a.status != b.status
        default: true
        }
    }
}
