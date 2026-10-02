import SwiftUI
import UsageCore

@main
struct UsageDeckWatchApp: App {
    @State private var link = PhoneLink()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(link)
                .task { link.start() }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    link.setActive(phase == .active)
                }
        }
    }
}
