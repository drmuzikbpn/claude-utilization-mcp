import SwiftUI
import UsageCore
import WidgetKit

/// Watch complications. The snapshot timeline and "Highest" account choice arrive in the
/// complications phase.
@main
struct UsageComplicationsBundle: WidgetBundle {
    var body: some Widget {
        UsageComplication()
    }
}

struct ComplicationEntry: TimelineEntry {
    let date: Date
    let snapshot: WatchSnapshot
}

struct ComplicationProvider: TimelineProvider {
    func placeholder(in _: Context) -> ComplicationEntry {
        ComplicationEntry(date: .now, snapshot: .empty)
    }

    func getSnapshot(in _: Context, completion: @escaping (ComplicationEntry) -> Void) {
        completion(ComplicationEntry(date: .now, snapshot: .empty))
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) {
        completion(Timeline(entries: [ComplicationEntry(date: .now, snapshot: .empty)], policy: .never))
    }
}

struct UsageComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.evenseal.usagedeck.complication", provider: ComplicationProvider()) { entry in
            Text(entry.snapshot.accounts.first.map { "\($0.fiveHour?.percent ?? 0)%" } ?? "—")
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("5-hour usage")
        .description("The account closest to a limit.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryCorner, .accessoryInline])
    }
}
