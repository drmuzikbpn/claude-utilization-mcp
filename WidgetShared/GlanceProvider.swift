import UsageCore
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let face: GlanceFace
    let relevance: TimelineEntryRelevance?
}

/// Reads the App Group snapshot (written by the iPhone app for the iPhone widgets, by the watch
/// app for the complications) and steps it every 5 minutes for an hour so countdowns move. The
/// apps reload timelines when what the faces draw changes.
struct GlanceProvider: AppIntentTimelineProvider {
    func placeholder(in _: Context) -> GlanceEntry {
        Self.sampleEntry()
    }

    func snapshot(for configuration: SelectAccountIntent, in context: Context) async -> GlanceEntry {
        let stored = SharedSnapshotStore().read()
        if context.isPreview, stored?.hasDevices != true {
            return Self.sampleEntry(choice: configuration.choice)
        }
        return Self.entry(GlanceTimeline.moments(snapshot: stored, choice: configuration.choice, now: .now)[0])
    }

    func timeline(for configuration: SelectAccountIntent, in _: Context) async -> Timeline<GlanceEntry> {
        let moments = GlanceTimeline.moments(snapshot: SharedSnapshotStore().read(), choice: configuration.choice, now: .now)
        return Timeline(entries: moments.map(Self.entry), policy: .atEnd)
    }

    #if os(watchOS)
        /// Complications have no configuration UI on the watch: offer "Highest" and each account.
        func recommendations() -> [AppIntentRecommendation<SelectAccountIntent>] {
            AccountOptions.list(SharedSnapshotStore().read()).map { option in
                AppIntentRecommendation(intent: SelectAccountIntent(account: AccountEntity(option)), description: option.title)
            }
        }
    #endif

    static func entry(_ moment: GlanceTimeline.Moment) -> GlanceEntry {
        GlanceEntry(
            date: moment.date,
            face: moment.face,
            relevance: TimelineEntryRelevance(score: Float(moment.face.relevance * 100))
        )
    }

    static func sampleEntry(choice: AccountChoice = .highest) -> GlanceEntry {
        let now = Date.now
        return entry(GlanceTimeline.Moment(date: now, face: GlanceFace.make(snapshot: .sample(now: now), choice: choice, now: now)))
    }
}

enum Glance {
    /// Opens the app; handled by the app's `onOpenURL`.
    static let openURL = URL(string: "usagedeck://open")
}
