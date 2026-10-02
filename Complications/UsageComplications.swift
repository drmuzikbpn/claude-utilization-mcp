import SwiftUI
import UsageCore
import WidgetKit

/// Watch complications, drawn from the snapshot the watch app keeps in its App Group.
@main
struct UsageComplicationsBundle: WidgetBundle {
    var body: some Widget {
        UsageComplication()
    }
}

struct UsageComplication: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "com.evenseal.usagedeck.complication",
            intent: SelectAccountIntent.self,
            provider: GlanceProvider()
        ) { entry in
            GlanceView(entry: entry)
        }
        .configurationDisplayName("Usage")
        .description("How close an account is to its 5-hour and 7-day limits.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryCorner, .accessoryInline])
    }
}
