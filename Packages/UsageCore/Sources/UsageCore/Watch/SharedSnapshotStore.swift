import Foundation

/// The latest `WatchSnapshot`, kept in the App Group container so widgets and complications can
/// draw without talking to anything. Each side writes its own copy: the iPhone app for the iPhone
/// widgets, the watch app for the complications. App Group containers do not sync between them.
public struct SharedSnapshotStore: Sendable {
    public static let appGroup = "group.com.evenseal.usagedeck"
    static let fileName = "snapshot.json"

    private let directory: URL?

    /// The App Group container; `nil` when the entitlement is missing (unit tests, previews).
    public init(appGroup: String = Self.appGroup) {
        directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    /// A plain directory, for tests.
    public init(directory: URL) {
        self.directory = directory
    }

    private var fileURL: URL? {
        directory?.appendingPathComponent(Self.fileName)
    }

    /// Writes atomically. Errors are swallowed: a widget showing the previous snapshot is better
    /// than an app that fails a refresh over a full disk.
    public func write(_ snapshot: WatchSnapshot) {
        guard let url = fileURL, let data = try? WatchSnapshotCodec.encode(snapshot) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func read() -> WatchSnapshot? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? WatchSnapshotCodec.decode(data)
    }
}
