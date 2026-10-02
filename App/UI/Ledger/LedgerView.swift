import SwiftUI
import UsageCore

/// Portrait home (deck spec §11.1): who is burning what, right now, grouped by project.
struct LedgerView: View {
    @Bindable var store: DeckStore
    @State private var renaming: UserView?

    var body: some View {
        let team = store.team
        let empty = HomeEmpty.of(team)
        VStack(spacing: 0) {
            StatusBar(store: store)
            ForEach(team.usersWithData) { user in
                UserBlock(store: store, user: user) { renaming = user }
            }
            switch empty {
            case .noDevices, .connecting:
                HomeEmptyView(store: store, empty: empty ?? .noDevices)
                    .frame(maxHeight: .infinity)
            case .noSessions:
                ListCaption(title: "Sessions · 0 live", trailing: "tokens/min · 30m")
                HomeEmptyView(store: store, empty: empty ?? .noDevices)
                    .frame(maxHeight: .infinity)
            case nil:
                ListCaption(title: "Sessions · \(team.liveSessionCount) live", trailing: "tokens/min · 30m")
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(team.projects.filter { !$0.sessions.isEmpty }) { project in
                            ProjectHeader(store: store, project: project)
                            if store.expanded.contains("\(project.deviceId)|\(project.key)") {
                                ForEach(project.sessions) { session in
                                    SessionRow(store: store, deviceId: project.deviceId, projectKey: project.key, session: session)
                                }
                            }
                            Divider().overlay(DeckColor.line)
                        }
                    }
                }
                .frame(maxHeight: .infinity)
            }
            BottomBar(store: store, navigation: homeNavigation(store: store, empty: empty))
        }
        .background(DeckColor.bg)
        .renameAlert(store: store, user: $renaming)
    }
}

/// With nothing paired "Projects" is a dead end; "Pair" takes its place.
@MainActor
func homeNavigation(store: DeckStore, empty: HomeEmpty?) -> (label: String, action: () -> Void) {
    if empty == .noDevices {
        return ("Pair", { store.beginPairing() })
    }
    return ("Projects", { store.path.append(.projects) })
}
