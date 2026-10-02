import SwiftUI
import UsageCore
import WidgetKit

/// The deck's `RingNumber`: an arc from twelve o'clock on a faint full-circle track, the percent
/// (no sign) in the middle, both coloured by status.
struct RingGauge: View {
    let ring: RingFace
    var lineWidth: CGFloat = 6
    var numeralSize: CGFloat = 28

    var body: some View {
        let color = Theme.color(ring.status)
        ZStack {
            Circle()
                .stroke(Theme.line, lineWidth: lineWidth)
            if ring.fraction > 0 {
                Circle()
                    .trim(from: 0, to: ring.fraction)
                    .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .widgetAccentable()
            }
            Text(ring.label)
                .font(Theme.numeral(numeralSize))
                .foregroundStyle(color)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .padding(lineWidth)
        }
        .padding(lineWidth / 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ring.percent.map { "\($0) percent" } ?? "no reading")
    }
}
