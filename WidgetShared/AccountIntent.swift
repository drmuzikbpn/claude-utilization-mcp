import AppIntents
import UsageCore
import WidgetKit

/// One choice in a widget's account picker: "Highest" or a specific account (D9).
struct AccountEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Account"
    static let defaultQuery = AccountQuery()
    static let highest = AccountEntity(AccountOption(id: AccountChoice.highestId, title: AccountOptions.highestTitle))

    let id: String
    let title: String

    init(_ option: AccountOption) {
        id = option.id
        title = option.title
    }

    var choice: AccountChoice {
        AccountChoice(id: id)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

/// Lists "Highest" plus every account in the App Group snapshot.
struct AccountQuery: EntityQuery {
    func entities(for identifiers: [AccountEntity.ID]) async throws -> [AccountEntity] {
        AccountOptions.lookup(identifiers, in: SharedSnapshotStore().read()).map(AccountEntity.init)
    }

    func suggestedEntities() async throws -> [AccountEntity] {
        AccountOptions.list(SharedSnapshotStore().read()).map(AccountEntity.init)
    }

    func defaultResult() async -> AccountEntity? {
        .highest
    }
}

struct SelectAccountIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Account"
    static let description = IntentDescription("Which account to show. Highest follows whichever is closest to a limit.")

    @Parameter(title: "Account")
    var account: AccountEntity?

    init() {}

    init(account: AccountEntity) {
        self.account = account
    }

    var choice: AccountChoice {
        account?.choice ?? .highest
    }
}
