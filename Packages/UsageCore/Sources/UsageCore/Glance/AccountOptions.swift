import Foundation

public extension AccountChoice {
    /// The identifier "Highest" carries in a widget configuration. Account keys are
    /// `accountUuid/organizationUuid`, so they can never collide with it.
    static let highestId = "highest"

    init(id: String) {
        self = id == Self.highestId ? .highest : .account(key: id)
    }

    var id: String {
        switch self {
        case .highest: Self.highestId
        case let .account(key): key
        }
    }
}

/// One row of a widget's account picker.
public struct AccountOption: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }

    public var choice: AccountChoice {
        AccountChoice(id: id)
    }
}

/// What a widget can be set to show (D9): "Highest" first, then each account in snapshot order.
public enum AccountOptions {
    public static let highestTitle = "Highest"

    public static func list(_ snapshot: WatchSnapshot?) -> [AccountOption] {
        var seen: Set<String> = []
        let accounts = (snapshot?.accounts ?? []).filter { seen.insert($0.key).inserted }
        return [AccountOption(id: AccountChoice.highestId, title: highestTitle)]
            + accounts.map { AccountOption(id: $0.key, title: $0.name) }
    }

    /// The options matching `ids`, in the order asked. An account no longer in the snapshot
    /// keeps its id with a generic title, so a configured widget stays configured (it shows
    /// "Highest" until the account returns, per `Highest.resolve`).
    public static func lookup(_ ids: [String], in snapshot: WatchSnapshot?) -> [AccountOption] {
        let known = Dictionary(list(snapshot).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ids.map { known[$0] ?? AccountOption(id: $0, title: "Account") }
    }
}
