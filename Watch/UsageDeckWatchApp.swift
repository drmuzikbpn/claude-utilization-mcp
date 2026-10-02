import SwiftUI
import UsageCore

/// Watch entry point. Account pages, actions and project drill-in arrive in the watch phase.
@main
struct UsageDeckWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchPlaceholderView(snapshot: .empty)
        }
    }
}

struct WatchPlaceholderView: View {
    let snapshot: WatchSnapshot

    var body: some View {
        VStack(spacing: 6) {
            Text("Usage Deck")
                .font(.headline)
            if snapshot.hasDevices {
                Text("\(snapshot.accounts.count) accounts")
            } else {
                Text("No paired devices — pair one in the iPhone app")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
