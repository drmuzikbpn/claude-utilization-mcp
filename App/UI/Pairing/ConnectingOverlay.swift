import SwiftUI
import UsageCore

/// "Connecting to <name>…" after a pairing is redeemed: holds the device screen back until its
/// health, setup check and first summary are in (`FirstLoad`), so it opens fully populated
/// instead of on rows of "unknown". A checkmark beat on success; on an error or after the
/// timeout it opens the device anyway and the reason shows as a toast. Skip always works.
struct ConnectingOverlay: View {
    @Bindable var store: DeckStore
    var connecting: ConnectTracker.Attempt
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let phase = store.connectingPhase ?? .loading
        let ready = phase == .ready
        ZStack {
            // Swallows taps on whatever is behind; the card's Skip is the way out.
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .accessibilityHidden(true)
            // Landscape or the largest text sizes: scroll rather than clip Skip off-screen.
            ViewThatFits(in: .vertical) {
                card(ready: ready)
                ScrollView {
                    card(ready: ready)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .animation(reduceMotion ? nil : .smooth, value: ready)
        .sensoryFeedback(.success, trigger: ready) { _, new in new }
        .onAppear {
            AccessibilityNotification.ScreenChanged(nil).post()
        }
        .task(id: phase) {
            switch phase {
            case .ready:
                AccessibilityNotification.Announcement("Connected to \(name)").post()
                // Long enough to read the checkmark, short enough not to feel like a wait.
                try? await Task.sleep(for: .milliseconds(reduceMotion ? 500 : 900))
                guard !Task.isCancelled else { return }
                store.finishConnecting(connecting.id)
            case let .failed(message):
                store.finishConnecting(connecting.id, message: message)
            case .loading:
                break
            }
        }
    }

    private func card(ready: Bool) -> some View {
        VStack(spacing: 18) {
            ZStack {
                if ready {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(DeckColor.ok)
                        .symbolEffect(.bounce, options: .nonRepeating, isActive: !reduceMotion)
                        .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .tint(DeckColor.accent)
                        .transition(.opacity)
                }
            }
            .frame(height: 52)
            .accessibilityHidden(true)
            VStack(spacing: 6) {
                Text(ready ? "Connected" : "Connecting to \(name)…")
                    .font(DeckFont.text(17, .semibold))
                    .foregroundStyle(DeckColor.fg)
                    .multilineTextAlignment(.center)
                Text(ready ? name : "Reading its limits, sessions and setup")
                    .font(DeckFont.text(13))
                    .foregroundStyle(DeckColor.muted)
                    .multilineTextAlignment(.center)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            VStack(alignment: .leading, spacing: 8) {
                step("Health and setup check", done: store.setupChecks[connecting.deviceId] != nil)
                step("Limits and spend", done: store.team.device(connecting.deviceId)?.summaryLoaded == true)
            }
            Button("Skip") { store.finishConnecting(connecting.id) }
                .font(DeckFont.text(14, .medium))
                .foregroundStyle(DeckColor.accent)
                .opacity(ready ? 0 : 1)
                .disabled(ready)
                .accessibilityHidden(ready)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 26)
        .frame(maxWidth: 360)
        .deckGlass(in: RoundedRectangle(cornerRadius: 28, style: .continuous), tint: ready ? DeckColor.ok : nil)
        .padding(24)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ready ? "Connected to \(name)" : "Connecting to \(name)")
        .accessibilityAddTraits(.isModal)
    }

    private var name: String {
        Format.hostShort(store.team.device(connecting.deviceId)?.displayName ?? connecting.name)
    }

    private func step(_ title: String, done: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(done ? DeckColor.ok : DeckColor.dim)
                .contentTransition(.symbolEffect(.replace))
                .accessibilityHidden(true)
            Text(title)
                .font(DeckFont.text(13))
                .foregroundStyle(done ? DeckColor.fg : DeckColor.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityValue(done ? "done" : "waiting")
    }
}
