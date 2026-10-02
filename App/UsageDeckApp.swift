import SwiftUI
import UsageCore

/// The app's long-lived objects. Built once on the main actor; the background-refresh handler and
/// the scene both reach the same store.
@MainActor
enum AppGraph {
    static let notifier = AlertNotifier()
    static let store = makeStore()
    static let bridge = WatchBridge()

    private static func makeStore() -> DeckStore {
        #if DEBUG
            if DemoData.isEnabled {
                let defaults = UserDefaults(suiteName: "usagedeck.demo") ?? .standard
                defaults.removePersistentDomain(forName: "usagedeck.demo")
                let store = DeckStore(
                    defaults: defaults,
                    group: defaults,
                    tokens: InMemoryTokenStore(),
                    notifier: notifier,
                    shared: SharedSnapshotStore(directory: FileManager.default.temporaryDirectory)
                )
                store.seedDemo()
                return store
            }
        #endif
        return DeckStore(notifier: notifier)
    }

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
        .onChange(of: phase, initial: true) { _, phase in
            AppGraph.store.setActive(phase == .active)
            if phase == .background {
                BackgroundRefresh.schedule()
            }
        }
    }
}
