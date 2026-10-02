import SwiftUI
import UsageCore
import WidgetKit

/// iPhone home and lock-screen widgets. The App-Group snapshot timeline and per-widget account
/// choice ("Highest" by default) arrive in the widgets phase.
@main
struct UsageWidgetsBundle: WidgetBundle {
    var body: some Widget {
        UsageWidget()
    }
}

struct UsageEntry: TimelineEntry {
    let date: Date
    let snapshot: WatchSnapshot
}

struct UsageProvider: TimelineProvider {
    func placeholder(in _: Context) -> UsageEntry {
        UsageEntry(date: .now, snapshot: .empty)
    }

    func getSnapshot(in _: Context, completion: @escaping (UsageEntry) -> Void) {
        completion(UsageEntry(date: .now, snapshot: .empty))
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        completion(Timeline(entries: [UsageEntry(date: .now, snapshot: .empty)], policy: .never))
    }
}

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.evenseal.usagedeck.usage", provider: UsageProvider()) { entry in
            Text(entry.snapshot.hasDevices ? "Usage" : "No paired devices")
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("Usage")
        .description("How close your Claude account is to its limits.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
