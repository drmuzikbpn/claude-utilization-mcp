import SwiftUI

extension View {
    /// Liquid Glass where the OS has it (iOS and watchOS 26); before that a frosted material with
    /// a hairline rim, so the controls still float over the backdrop.
    @ViewBuilder
    func deckGlass(in shape: some InsettableShape, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26, watchOS 26, *) {
            glassEffect(Glass.regular.tint(tint?.opacity(0.32)).interactive(interactive), in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
                .background((tint ?? .clear).opacity(0.16), in: shape)
                .overlay(shape.strokeBorder(.white.opacity(0.09), lineWidth: 1))
        }
    }

    /// Figures that tick roll digit by digit instead of snapping.
    func rolling(_ value: some Equatable) -> some View {
        contentTransition(.numericText()).animation(.snappy, value: value)
    }
}

/// Glass shapes that sit close together blend and morph as one on iOS 26; a plain stack before.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26, watchOS 26, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}
