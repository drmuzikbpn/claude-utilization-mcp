import SwiftUI
import UsageCore
import WidgetKit

/// Every widget and complication family, drawn from one `GlanceFace`.
struct GlanceView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        GlanceContent(face: entry.face, family: family)
            .widgetURL(Glance.openURL)
            .containerBackground(Theme.ground, for: .widget)
    }
}

/// The face for an explicit family; split from `GlanceView` so the render tests can draw each
/// family outside WidgetKit.
struct GlanceContent: View {
    let face: GlanceFace
    let family: WidgetFamily

    var body: some View {
        if face.state != .account {
            EmptyGlance(state: face.state, family: family)
        } else {
            switch family {
            case .accessoryCircular: CircularGlance(face: face)
            case .accessoryRectangular: RectangularGlance(face: face)
            case .accessoryInline: InlineGlance(face: face)
            #if os(watchOS)
                case .accessoryCorner: CornerGlance(face: face)
            #endif
            #if os(iOS)
                case .systemMedium: MediumGlance(face: face)
            #endif
            default: SmallGlance(face: face)
            }
        }
    }
}

extension GlanceFace {
    /// Whose numbers these are: the initial on "Highest", the name on a fixed choice.
    var label: String {
        isHighest ? initial : name
    }

    var faded: Bool {
        health != .fresh
    }
}

private struct EmptyGlance: View {
    let state: GlanceFace.State
    let family: WidgetFamily

    var body: some View {
        let text = state == .noDevices ? "No paired devices" : "Open Usage Deck"
        switch family {
        case .accessoryInline:
            Text(text)
        case .accessoryCircular:
            Image(systemName: "gauge.with.dots.needle.33percent")
                .font(.title2)
                .accessibilityLabel(text)
        default:
            Text(text)
                .font(.system(.footnote, design: .rounded))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
    }
}

private struct CircularGlance: View {
    let face: GlanceFace

    var body: some View {
        Gauge(value: face.fiveHour.fraction) {
            Text(face.isHighest ? face.initial : "5h")
        } currentValueLabel: {
            Text(face.fiveHour.label)
                .font(Theme.numeral(20))
        }
        .gaugeStyle(.accessoryCircular)
        .tint(Theme.color(face.fiveHour.status))
        .opacity(face.faded ? Theme.staleFade : 1)
        .accessibilityLabel("\(face.name), five hour window \(face.fiveHour.label) percent")
    }
}

private struct RectangularGlance: View {
    let face: GlanceFace

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Text(face.name)
                    .font(.system(.headline, design: .rounded))
                    .widgetAccentable()
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(face.age ?? face.fiveHourCountdown)
                    .font(Theme.data(13))
                    .foregroundStyle(face.age == nil ? Theme.text : Theme.warn)
            }
            WindowBar(title: "5h", ring: face.fiveHour)
            WindowBar(title: "7d", ring: face.sevenDay)
        }
        .opacity(face.faded ? Theme.staleFade : 1)
    }
}

private struct WindowBar: View {
    let title: String
    let ring: RingFace

    var body: some View {
        HStack(spacing: 4) {
            Text(title)
                .font(Theme.data(12))
                .foregroundStyle(Theme.muted)
                .frame(width: 18, alignment: .leading)
            // A drawn bar rather than `.accessoryLinearCapacity`, which repeats its label above
            // the track and leaves no room for the second window.
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.line)
                    Capsule()
                        .fill(Theme.color(ring.status))
                        .frame(width: max(proxy.size.height, proxy.size.width * ring.fraction))
                        .opacity(ring.fraction > 0 ? 1 : 0)
                        .widgetAccentable()
                }
            }
            .frame(height: 5)
            Text(ring.label)
                .font(Theme.numeral(17))
                .foregroundStyle(Theme.color(ring.status))
                .frame(minWidth: 24, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) \(ring.label) percent")
    }
}

private struct InlineGlance: View {
    let face: GlanceFace

    var body: some View {
        Text("\(face.label) \(face.fiveHour.label)% · 7d \(face.sevenDay.label)% · \(face.age ?? face.fiveHourCountdown)")
    }
}

#if os(watchOS)
    private struct CornerGlance: View {
        let face: GlanceFace

        var body: some View {
            Text(face.fiveHour.label)
                .font(Theme.numeral(22))
                .foregroundStyle(Theme.color(face.fiveHour.status))
                .widgetCurvesContent()
                .widgetLabel {
                    Gauge(value: face.fiveHour.fraction) {
                        Text("5h")
                    } currentValueLabel: {
                        Text(face.fiveHour.label)
                    } minimumValueLabel: {
                        Text(face.isHighest ? face.initial : "")
                    } maximumValueLabel: {
                        Text(face.fiveHourCountdown)
                    }
                    .tint(Theme.color(face.fiveHour.status))
                }
                .opacity(face.faded ? Theme.staleFade : 1)
        }
    }
#endif

/// Small: the 5 h window as the deck's big ring, the 7 d window as a line under it.
private struct SmallGlance: View {
    let face: GlanceFace

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GlanceHeader(face: face)
            RingGauge(ring: face.fiveHour, lineWidth: 8, numeralSize: 34)
                .frame(maxWidth: .infinity)
                .opacity(face.faded ? Theme.staleFade : 1)
            HStack {
                Text("5h \(face.fiveHourCountdown)")
                Spacer(minLength: 2)
                Text("7d \(face.sevenDay.label)")
                    .foregroundStyle(Theme.color(face.sevenDay.status))
            }
            .font(Theme.data(12))
            .foregroundStyle(Theme.text)
        }
    }
}

#if os(iOS)
    /// Medium: both rings with their countdown and reset time, like the deck's WideDock rail.
    private struct MediumGlance: View {
        let face: GlanceFace

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                GlanceHeader(face: face)
                HStack(spacing: 16) {
                    window(face.fiveHour, "5 h", face.fiveHourCountdown, face.fiveHourResetAt)
                    window(face.sevenDay, "7 d", face.sevenDayCountdown, face.sevenDayResetAt)
                }
                .opacity(face.faded ? Theme.staleFade : 1)
            }
        }

        private func window(_ ring: RingFace, _ title: String, _ countdown: String, _ resetAt: String) -> some View {
            HStack(spacing: 8) {
                RingGauge(ring: ring, lineWidth: 8, numeralSize: 34)
                    .frame(width: 96, height: 96)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Theme.data(12))
                        .foregroundStyle(Theme.muted)
                    Text(countdown)
                        .font(Theme.numeral(20))
                        .foregroundStyle(Theme.text)
                    Text(resetAt)
                        .font(Theme.data(11))
                        .foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
#endif

private struct GlanceHeader: View {
    let face: GlanceFace

    var body: some View {
        HStack(spacing: 4) {
            Text(face.name.uppercased())
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .kerning(0.5)
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let age = face.age {
                Text(age)
                    .font(Theme.data(11))
                    .foregroundStyle(Theme.color(face.health))
                Circle()
                    .fill(Theme.color(face.health))
                    .frame(width: 5, height: 5)
            }
        }
    }
}
