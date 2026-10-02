import SwiftUI

/// Rows leapfrog as projects re-rank by live burn (deck `Reorder.kt`). The list slides every row
/// to its new place; on top of that the row that climbs lifts over its neighbours — drawn above
/// them, a touch larger, on its own raised surface — and every row that moved blinks once so the
/// eye catches the change. Rows that fall only slide.
struct LiftOnReorder: ViewModifier {
    /// The row's rank in the list; the effect plays whenever it changes.
    let rank: Int

    @State private var last: Int?
    @State private var lifted = false
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .background(
                DeckColor.surface2.opacity(lifted ? 1 : 0),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .scaleEffect(lifted ? Reorder.liftScale : 1)
            .shadow(color: .black.opacity(lifted ? 0.5 : 0), radius: lifted ? 14 : 0, y: lifted ? 6 : 0)
            .shadow(color: DeckColor.accent.opacity(lifted ? 0.35 : 0), radius: lifted ? 10 : 0)
            .opacity(dimmed ? Reorder.blinkFloor : 1)
            .zIndex(lifted ? 1 : 0)
            .onChange(of: rank, initial: true) { old, new in
                defer { last = new }
                guard let previous = last ?? (old == new ? nil : old), previous != new else { return }
                play(climbed: new < previous)
            }
    }

    private func play(climbed: Bool) {
        withAnimation(.easeOut(duration: Reorder.blinkOut)) { dimmed = true }
        withAnimation(.easeIn(duration: Reorder.blinkIn).delay(Reorder.blinkOut)) { dimmed = false }
        guard climbed else { return }
        withAnimation(.snappy(duration: Reorder.liftUp)) { lifted = true }
        withAnimation(.smooth(duration: Reorder.liftDown).delay(Reorder.liftUp + Reorder.liftHold)) { lifted = false }
    }
}

enum Reorder {
    /// The list's own slide when rows change places: long enough to follow, short enough not to
    /// lag the data.
    static let slide = Animation.snappy(duration: 0.45, extraBounce: 0.04)
    static let blinkFloor = 0.3
    static let blinkOut = 0.11
    static let blinkIn = 0.38
    static let liftUp = 0.16
    static let liftHold = 0.2
    static let liftDown = 0.32
    static let liftScale = 1.035

    /// A row's rank: the project's slot, then the row's slot inside it. Rows only "move" when a
    /// project overtakes another or a session re-ranks inside its project — never because a block
    /// above folded open or gained a row.
    static func rank(project: Int, row: Int = 0) -> Int {
        project * 1000 + row
    }
}

extension View {
    func liftOnReorder(_ rank: Int) -> some View {
        modifier(LiftOnReorder(rank: rank))
    }
}
