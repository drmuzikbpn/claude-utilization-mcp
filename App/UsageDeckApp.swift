// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

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
                notifier.muted = true
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
        if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            // Logs written before names and addresses were marked (and alert text left out) are
            // not carried over: that file is deleted, and the diary starts again in a new one.
            try? FileManager.default.removeItem(at: support.appending(path: "diagnostics.log"))
            // Its own folder, kept out of device backups (the file itself is rewritten atomically,
            // which would drop the flag from it).
            var folder = support.appending(path: "Logs", directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? folder.setResourceValues(values)
            DiagLog.shared.attach(file: folder.appending(path: "debug.log"))
        }
        let info = Bundle.main.infoDictionary
        DiagLog.shared.log(
            .app,
            "launched \(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?")), "
                + "iOS \(ProcessInfo.processInfo.operatingSystemVersionString), \(store.records.count) paired"
        )
        notifier.install()
        notifier.onRepair = { store.beginPairing(replacing: $0) }
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
