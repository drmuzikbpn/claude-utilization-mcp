import Foundation

/// The names this install's owner chose for accounts, keyed by `UserView.key`.
/// Display falls back to the daemon's `displayName`, then the e-mail's local part.
public struct UserNames: Codable, Sendable, Equatable {
    public var names: [String: String]

    public init(_ names: [String: String] = [:]) {
        self.names = names.compactMapValues { name in
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    /// The name to draw for `user`: the app's own rename first, the daemon's display name otherwise.
    public func name(for user: UserView) -> String {
        rename(for: user) ?? user.displayName
    }

    /// The stored rename, if any. A name given before the daemon reported the organisation lives
    /// under the bare account key, so that key is tried second rather than lost.
    public func rename(for user: UserView) -> String? {
        let bare = user.key.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? user.key
        return names[user.key] ?? names[bare]
    }

    /// Sets or, with a blank `name`, clears the rename for `key`.
    public func renamed(_ key: String, to name: String) -> UserNames {
        var copy = names
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        copy[key] = trimmed.isEmpty ? nil : trimmed
        return UserNames(copy)
    }
}
