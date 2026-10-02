import SwiftUI
import UsageCore
import WidgetKit

/// iPhone home and lock-screen widgets, drawn from the snapshot the iPhone app keeps in the App
/// Group.
@main
struct UsageWidgetsBundle: WidgetBundle {
    var body: some Widget {
        UsageWidget()
    }
}

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "com.evenseal.usagedeck.usage",
            intent: SelectAccountIntent.self,
            provider: GlanceProvider()
        ) { entry in
            GlanceView(entry: entry)
        }
        .configurationDisplayName("Usage")
        .description("How close an account is to its 5-hour and 7-day limits.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

#Preview("Small", as: .systemSmall) {
    UsageWidget()
} timeline: {
    GlanceProvider.sampleEntry()
}

#Preview("Medium", as: .systemMedium) {
    UsageWidget()
} timeline: {
    GlanceProvider.sampleEntry()
}
