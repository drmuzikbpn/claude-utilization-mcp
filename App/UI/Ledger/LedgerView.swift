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
            RepairBanners(store: store)
            if !team.usersWithData.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(team.usersWithData.enumerated()), id: \.element.id) { index, user in
                        if index > 0 {
                            Divider().overlay(DeckColor.line).padding(.leading, 24)
                        }
                        UserBlock(store: store, user: user) { renaming = user }
                    }
                }
                .padding(.vertical, 2)
                .deckCard(radius: 20)
                .padding(.horizontal, 10)
                .padding(.top, 4)
            }
            switch empty {
            case .noDevices, .connecting, .needsRepair:
                HomeEmptyView(store: store, empty: empty ?? .noDevices)
                    .frame(maxHeight: .infinity)
            case .noSessions:
                ListCaption(title: "Sessions · 0 live", trailing: "tokens/min · 30m")
                HomeEmptyView(store: store, empty: empty ?? .noDevices)
                    .frame(maxHeight: .infinity)
            case nil:
                ListCaption(title: "Sessions · \(team.liveSessionCount) live", trailing: "tokens/min · 30m")
                ScrollView {
                    let live = store.liveProjects
                    LazyVStack(spacing: 8) {
                        ForEach(Array(live.enumerated()), id: \.element.id) { index, project in
                            VStack(spacing: 0) {
                                ProjectHeader(store: store, project: project)
                                if store.expanded.contains("\(project.deviceId)|\(project.key)") {
                                    ForEach(Array(project.sessions.enumerated()), id: \.element.id) { row, session in
                                        SessionRow(store: store, deviceId: project.deviceId, projectKey: project.key, session: session)
                                            .liftOnReorder(Reorder.rank(project: 0, row: row))
                                            .transition(.move(edge: .top).combined(with: .opacity))
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                            .deckCard()
                            .zoomSource(deviceId: project.deviceId, key: project.key)
                            .liftOnReorder(Reorder.rank(project: index))
                        }
                    }
                    .padding(.horizontal, 10)
                    .animation(Reorder.slide, value: live.map(\.id))
                }
                .scrollIndicators(.hidden)
                .frame(maxHeight: .infinity)
            }
        }
        // The bar floats; the list scrolls on under its glass.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            BottomBar(store: store, navigation: homeNavigation(store: store, empty: empty))
        }
        .deckScreen()
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
