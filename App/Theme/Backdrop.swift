import SwiftUI
import UsageCore

/// The ground every screen sits on: the deck's near-black with a slow, faint aurora tinted by the
/// worst limit on the team — green while everyone has room, amber at a warning, red at critical.
/// It is also what the glass controls refract, so they read as glass rather than grey.
struct DeckBackdrop: View {
    @Environment(\.deckGlow) private var glow
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 15, paused: reduceMotion)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            MeshGradient(
                width: 3,
                height: 3,
                points: Self.points(t),
                colors: [
                    glow.opacity(0.42), DeckColor.bg, DeckColor.accent.opacity(0.14),
                    DeckColor.bg, DeckColor.surface.opacity(0.6), DeckColor.bg,
                    DeckColor.accent.opacity(0.12), DeckColor.bg, glow.opacity(0.24),
                ],
                background: DeckColor.bg
            )
        }
        .background(DeckColor.bg)
        .animation(.smooth(duration: 1.5), value: glow)
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    /// The corners stay pinned; the middle row and column drift a few percent on slow, unrelated
    /// periods so the glow never visibly loops.
    private static func points(_ t: TimeInterval) -> [SIMD2<Float>] {
        func wave(_ period: Double, _ phase: Double) -> Float {
            Float(sin(t * 2 * .pi / period + phase)) * 0.07
        }
        return [
            [0, 0], [0.5 + wave(23, 0), 0], [1, 0],
            [0, 0.45 + wave(19, 1)], [0.5 + wave(29, 2), 0.5 + wave(17, 3)], [1, 0.55 + wave(31, 4)],
            [0, 1], [0.5 + wave(37, 5), 1], [1, 1],
        ]
    }
}

extension EnvironmentValues {
    /// The backdrop's tint: the colour of the worst limit on the team.
    @Entry var deckGlow: Color = DeckColor.ok
    /// Where project rows register as zoom sources for the project screen.
    @Entry var deckZoom: Namespace.ID?
}

extension View {
    /// A pushed or presented screen's ground.
    func deckScreen() -> some View {
        background { DeckBackdrop() }
    }

    /// Registers this view as where the project screen zooms out of (and back into).
    func zoomSource(deviceId: String, key: String) -> some View {
        modifier(ZoomSource(id: ZoomSource.id(deviceId: deviceId, key: key)))
    }
}

struct ZoomSource: ViewModifier {
    @Environment(\.deckZoom) private var namespace
    /// Nil registers nothing (a row that is not its project's zoom source).
    var id: String?

    static func id(deviceId: String, key: String) -> String {
        "\(deviceId)|\(key)"
    }

    func body(content: Content) -> some View {
        if let namespace, let id {
            content.matchedTransitionSource(id: id, in: namespace)
        } else {
            content
        }
    }
}

/// A card for content rows: translucent surface over the backdrop with a hairline rim. Glass is
/// kept for the controls you touch; content sits on these.
struct DeckCard: ViewModifier {
    var radius: CGFloat = 16
    var fill = DeckColor.surface.opacity(0.62)

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background(fill, in: shape)
            .overlay(shape.strokeBorder(.white.opacity(0.06), lineWidth: 1))
            .clipShape(shape)
    }
}

extension View {
    func deckCard(radius: CGFloat = 16) -> some View {
        modifier(DeckCard(radius: radius))
    }
}

extension DeckStore {
    /// The worst status across every account's 5 h and 7 d windows; nil before any data.
    var worstStatus: LimitStatus? {
        team.usersWithData.flatMap { [$0.fiveHour?.status, $0.sevenDay?.status] }.compactMap(\.self).max()
    }
}
