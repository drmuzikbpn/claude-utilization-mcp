import Foundation

/// Anything with the two headline percentages: a live `UserView` or a watch snapshot account.
public protocol HeadlineAccount {
    var accountKey: String { get }
    var fiveHourPercent: Int? { get }
    var sevenDayPercent: Int? { get }
}

extension UserView: HeadlineAccount {
    public var accountKey: String {
        key
    }

    public var fiveHourPercent: Int? {
        fiveHour?.percent
    }

    public var sevenDayPercent: Int? {
        sevenDay?.percent
    }
}

/// Which account a widget or complication shows: a fixed one, or "Highest" (D9).
public enum AccountChoice: Codable, Sendable, Hashable {
    case highest
    case account(key: String)
}

/// "Highest": the account closest to any of its limits.
public enum Highest {
    /// The account whose larger headline percent is highest. Ties go to the higher other
    /// headline, then to the earlier account, so the pick does not flicker between equals.
    public static func pick<A: HeadlineAccount>(_ accounts: [A]) -> A? {
        var best: (account: A, rank: (Int, Int))?
        for account in accounts {
            let five = account.fiveHourPercent ?? -1
            let seven = account.sevenDayPercent ?? -1
            let rank = (max(five, seven), min(five, seven))
            if let current = best, !(rank > current.rank) {
                continue
            }
            best = (account, rank)
        }
        return best?.account
    }

    /// Resolves a widget's choice; a fixed account that is gone falls back to "Highest".
    public static func resolve<A: HeadlineAccount>(_ choice: AccountChoice, in accounts: [A]) -> A? {
        if case let .account(key) = choice, let match = accounts.first(where: { $0.accountKey == key }) {
            return match
        }
        return pick(accounts)
    }

    /// The single-letter label a "Highest" complication wears so the wrist knows whose it is.
    public static func initial(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "?"
    }
}
