import SwiftUI
import UsageCore

/// Portrait shows the Ledger, landscape the wide dock; both push the same routes. Pairing is a
/// sheet so a Camera-opened link can land on top of whatever is showing.
struct RootView: View {
    @Bindable var store: DeckStore
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var zoom

    var body: some View {
        NavigationStack(path: $store.path) {
            Group {
                if verticalSizeClass == .compact {
                    WideDockView(store: store)
                } else {
                    LedgerView(store: store)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: DeckStore.Route.self) { route in
                switch route {
                case .projects: ProjectsScreen(store: store)
                case let .project(deviceId, key):
                    ProjectScreen(store: store, deviceId: deviceId, key: key)
                        .navigationTransition(.zoom(sourceID: ZoomSource.id(deviceId: deviceId, key: key), in: zoom))
                case let .device(id): DeviceScreen(store: store, id: id)
                case .settings: SettingsScreen(store: store)
                }
            }
        }
        .sheet(isPresented: $store.showPairing, onDismiss: store.cancelPairing, content: { PairingScreen(store: store) })
        .confirmPairing(store: store, active: !store.showPairing)
        .overlay(alignment: .bottom) {
            if let toast = store.toast {
                ToastView(text: toast)
                    .allowsHitTesting(false)
            }
        }
        .overlay {
            if store.pairingInFlight, !store.showPairing {
                ProgressView("Pairing…")
                    .padding(20)
                    .deckGlass(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
        }
        .overlay {
            if let connecting = store.connecting {
                ConnectingOverlay(store: store, connecting: connecting)
                    .transition(.opacity)
            }
        }
        .animation(.snappy, value: store.toast)
        .animation(reduceMotion ? nil : .smooth, value: store.connecting?.deviceId)
        .sensoryFeedback(.error, trigger: store.toastSerial)
        // A limit crossing into warn or critical is felt as well as seen.
        .sensoryFeedback(trigger: store.worstStatus) { old, new in
            // Not on the first reading after launch: only a change you could have missed.
            guard let old, let new, new > old else { return nil }
            return .warning
        }
        .tint(DeckColor.accent)
        .preferredColorScheme(.dark)
        .background { DeckBackdrop() }
        // Last, so the backdrop above and every pushed screen see them.
        .environment(\.deckGlow, store.worstStatus.map(DeckColor.of) ?? DeckColor.accent)
        .environment(\.deckZoom, zoom)
    }
}

/// "Pair <name>?" — the one confirmation every pairing path (Camera link, scanner, paste) goes
/// through. Attached to the root and to the pairing sheet; only the frontmost one is active.
private struct ConfirmPairing: ViewModifier {
    @Bindable var store: DeckStore
    var active: Bool

    func body(content: Content) -> some View {
        content.alert(
            "Pair \(store.pendingInvite?.name ?? "device")?",
            isPresented: Binding(get: { active && store.pendingInvite != nil }, set: {
                if !$0 {
                    store.pendingInvite = nil
                }
            }),
            presenting: store.pendingInvite
        ) { invite in
            // Pass the presented invite: dismissing the alert runs the binding's setter, which
            // clears `pendingInvite`, before this action does.
            Button("Pair") { Task { await store.confirmPairing(invite) } }
            Button("Cancel", role: .cancel) { store.pendingInvite = nil }
        } message: { invite in
            Text("Usage Deck will connect to \(invite.addrs.joined(separator: ", ")) over HTTPS pinned to this device's certificate.")
        }
    }
}

extension View {
    func confirmPairing(store: DeckStore, active: Bool) -> some View {
        modifier(ConfirmPairing(store: store, active: active))
    }
}
