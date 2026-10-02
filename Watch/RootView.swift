import SwiftUI
import UsageCore

enum Route: Hashable {
    case projects
    case project(id: String)
}

/// Vertical pages: one per account, then Actions. Projects and project detail push on top.
struct RootView: View {
    @Environment(PhoneLink.self) private var link
    @State private var path: [Route] = []
    @State private var page: String?

    static let actionsPage = "actions"

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .projects: ProjectsView()
                    case let .project(id): ProjectDetailView(projectId: id)
                    }
                }
        }
        .tint(Theme.text)
        .onAppear(perform: applyDebugScreen)
        #if DEBUG
            .environment(\.isLuminanceReduced, DebugLaunch.alwaysOn ? true : isLuminanceReduced)
        #endif
    }

    #if DEBUG
        @Environment(\.isLuminanceReduced) private var isLuminanceReduced
    #endif

    @ViewBuilder private var content: some View {
        if let snapshot = link.snapshot, snapshot.generatedAt != .distantPast {
            if snapshot.hasDevices {
                TabView(selection: $page) {
                    ForEach(snapshot.accounts) { account in
                        AccountPage(account: account, snapshot: snapshot)
                            .tag(Optional(account.id))
                    }
                    if snapshot.accounts.isEmpty {
                        MessagePage(text: "No account readings yet — open a Claude Code session")
                    }
                    ActionsPage(snapshot: snapshot)
                        .tag(Optional(Self.actionsPage))
                }
                .tabViewStyle(.verticalPage)
            } else {
                MessagePage(text: "No paired devices — pair one in the iPhone app")
            }
        } else {
            MessagePage(text: link.reachable ? "Waiting for iPhone…" : "Open Usage Deck on your iPhone")
        }
    }

    private func applyDebugScreen() {
        #if DEBUG
            guard let snapshot = link.snapshot else { return }
            switch DebugLaunch.screen {
            case "actions":
                page = Self.actionsPage
            case "projects":
                path = [.projects]
            case "project":
                if let first = snapshot.projectsLiveFirst.first {
                    path = [.projects, .project(id: first.id)]
                }
            default:
                break
            }
        #endif
    }
}

/// A full page of explanation: the empty states.
struct MessagePage: View {
    @Environment(PhoneLink.self) private var link
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            if !link.reachable, link.snapshot != nil {
                UnreachableBanner()
            }
            Spacer(minLength: 0)
            Text(text)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.muted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .containerBackground(Theme.ground.gradient, for: .tabView)
    }
}

/// "iPhone not reachable · updated 4m ago", ticking.
struct UnreachableBanner: View {
    @Environment(PhoneLink.self) private var link

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text((link.snapshot ?? .empty).unreachableBanner(now: context.date))
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(Theme.warn)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 3)
                .background(Theme.warn.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityAddTraits(.isStaticText)
    }
}
