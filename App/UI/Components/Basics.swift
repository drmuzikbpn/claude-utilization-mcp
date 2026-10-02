import SwiftUI
import UsageCore

/// A pill: 1 pt `line` border on `surface`, a 7 pt status dot, mono 11 pt text.
struct Chip: View {
    var text: String
    var dot: Color?
    var tint: Color = DeckColor.fg
    var action: (() -> Void)?

    var body: some View {
        let label = HStack(spacing: 6) {
            if let dot {
                Circle().fill(dot).frame(width: 7, height: 7)
            }
            if !text.isEmpty {
                Text(text)
                    .font(DeckFont.mono(11))
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(DeckColor.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(tint == DeckColor.fg ? DeckColor.line : tint.opacity(0.35), lineWidth: 1))

        if let action {
            Button(action: action) { label }.buttonStyle(.plain)
        } else {
            label
        }
    }
}

/// The small rounded label: mono 10 pt. Neutral on `surface2`, or tinted at 15 % with full-colour text.
struct Tag: View {
    var text: String
    var color: Color?

    var body: some View {
        Text(text)
            .font(DeckFont.mono(10))
            .foregroundStyle(color ?? DeckColor.muted)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background((color?.opacity(0.15) ?? DeckColor.surface2), in: RoundedRectangle(cornerRadius: 5))
    }
}

/// One utilisation window as a row: `5h | ████░░░░ | 42% | 2h33 left`. Nil renders `—`.
struct LimitBar: View {
    var label: String
    var limit: Limit?
    var now: Date
    var use24h: Bool

    var body: some View {
        let percent = limit.map { min(max($0.percent, 0), 100) }
        let color = limit.map { DeckColor.of($0.status) } ?? DeckColor.dim
        HStack(spacing: 8) {
            Text(label)
                .font(DeckFont.mono(11))
                .foregroundStyle(DeckColor.muted)
                .frame(width: 24, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(DeckColor.surface2)
                    if let percent, percent > 0 {
                        Capsule().fill(color).frame(width: geo.size.width * CGFloat(percent) / 100)
                    }
                }
            }
            .frame(height: 8)
            Text(percent.map { "\($0)%" } ?? "—")
                .font(DeckFont.numeral(18, .medium))
                .foregroundStyle(color)
                .frame(width: 44, alignment: .trailing)
            Text(limit == nil ? "—" : Format.resetsShort(limit?.resetsAt, now: now, use24h: use24h))
                .font(DeckFont.mono(10))
                .foregroundStyle(DeckColor.muted)
                .lineLimit(1)
                .frame(width: 76, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A burn trace: filled area, line, endpoint dot. Axis-free — the number beside it carries the
/// magnitude, this only carries the shape.
struct Sparkline: View {
    var series: [Double]
    var color: Color = DeckColor.accent

    var body: some View {
        Canvas { context, size in
            guard series.count >= 2, size.width > 0, size.height > 0,
                  let high = series.max(), let low = series.min()
            else { return }
            let span = high - low > 0 ? high - low : 1
            let step = size.width / CGFloat(series.count - 1)
            let stroke: CGFloat = 1.5
            let usable = max(size.height - stroke, 0)
            let points = series.enumerated().map { index, value in
                CGPoint(x: CGFloat(index) * step, y: stroke / 2 + (1 - CGFloat((value - low) / span)) * usable)
            }
            var area = Path()
            area.move(to: CGPoint(x: points[0].x, y: size.height))
            points.forEach { area.addLine(to: $0) }
            area.addLine(to: CGPoint(x: points[points.count - 1].x, y: size.height))
            area.closeSubpath()
            context.fill(area, with: .color(color.opacity(0.18)))
            var line = Path()
            line.addLines(points)
            context.stroke(line, with: .color(color), lineWidth: stroke)
            let end = points[points.count - 1]
            context.fill(Path(ellipseIn: CGRect(x: end.x - 2, y: end.y - 2, width: 4, height: 4)), with: .color(color))
        }
        .accessibilityHidden(true)
    }
}

/// A secondary (ghost) button: bordered, transparent, neutral text.
struct DeckButton: View {
    var label: String
    var systemImage: String?
    var padding: CGFloat = 10
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 15, weight: .medium))
                } else {
                    Text(label).font(DeckFont.text(14, .medium))
                }
            }
            .foregroundStyle(DeckColor.fg)
            .padding(.horizontal, 14)
            .padding(.vertical, padding)
            .frame(maxHeight: .infinity)
            .overlay(DeckMetrics.buttonShape.strokeBorder(DeckColor.line, lineWidth: 1))
            .contentShape(DeckMetrics.buttonShape)
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityLabel(label)
    }
}

/// Section caption for the list headers.
struct ListCaption: View {
    var title: String
    var trailing: String

    var body: some View {
        HStack {
            Text(title)
                .font(DeckFont.text(12, .medium))
                .foregroundStyle(DeckColor.muted)
            Spacer()
            Text(trailing)
                .font(DeckFont.text(11))
                .foregroundStyle(DeckColor.dim)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(DeckColor.surface2)
    }
}

/// The bottom-of-screen failure line (a refused pause, an unreachable device).
struct ToastView: View {
    var text: String

    var body: some View {
        Text(text)
            .font(DeckFont.text(13, .medium))
            .foregroundStyle(DeckColor.fg)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(DeckColor.surface2, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(DeckColor.crit.opacity(0.5), lineWidth: 1))
            .padding(.horizontal, 16)
            .padding(.bottom, 72)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
