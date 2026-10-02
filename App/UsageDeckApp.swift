import SwiftUI
import UsageCore

/// iPhone entry point. The screens (Ledger, WideDock, pairing, device detail, settings) arrive
/// in later phases; this placeholder proves the target links UsageCore and handles pairing links.
@main
struct UsageDeckApp: App {
    @State private var lastLink: String?

    var body: some Scene {
        WindowGroup {
            PlaceholderView(lastLink: lastLink)
                .onOpenURL { url in
                    lastLink = switch PairingLink.parse(url) {
                    case let .success(.invite(invite)): "Pair with \(invite.name)"
                    case .success(.legacy): "This is an old pairing code. Run `claude-usage pair` on the device."
                    case let .failure(error): error.message
                    }
                }
        }
    }
}

struct PlaceholderView: View {
    let lastLink: String?

    var body: some View {
        VStack(spacing: 12) {
            Text("Usage Deck")
                .font(.largeTitle.weight(.semibold))
            Text("No paired devices")
                .foregroundStyle(.secondary)
            if let lastLink {
                Text(lastLink)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
        .preferredColorScheme(.dark)
    }
}
