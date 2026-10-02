import SwiftUI
import UsageCore

/// The app's long-lived objects. Built once on the main actor; the background-refresh handler and
/// the scene both reach the same store.
@MainActor
enum AppGraph {
    static let notifier = AlertNotifier()
    static let store = DeckStore(notifier: notifier)
    static let bridge = WatchBridge()

    static func boot() {
        notifier.install()
        bridge.attach(store)
    }
}

@main
struct UsageDeckApp: App {
    @Environment(\.scenePhase) private var phase

    init() {
        BackgroundRefresh.register {
            await AppGraph.store.backgroundRefresh()
        }
        AppGraph.boot()
    }

    var body: some Scene {
        WindowGroup {
            RootView(store: AppGraph.store)
                .onOpenURL { AppGraph.store.handle(url: $0) }
        }
        .onChange(of: phase) { _, phase in
            AppGraph.store.setActive(phase == .active)
            if phase == .background {
                BackgroundRefresh.schedule()
            }
        }
    }
}
