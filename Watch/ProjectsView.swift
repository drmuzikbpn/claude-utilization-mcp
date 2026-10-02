import SwiftUI
import UsageCore

/// Every project the iPhone sent: live ones first with a dot, idle ones dimmed after.
struct ProjectsView: View {
    @Environment(PhoneLink.self) private var link

    var body: some View {
        let snapshot = link.snapshot ?? .empty
        List {
            if !link.reachable {
                UnreachableBanner()
                    .listRowBackground(Color.clear)
            }
            ForEach(snapshot.projectsLiveFirst) { project in
                NavigationLink(value: Route.project(id: project.id)) {
                    ProjectRow(project: project)
                }
            }
            if snapshot.projects.isEmpty {
                Text("No projects today")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Projects")
        .containerBackground(Theme.ground.gradient, for: .navigation)
    }
}

private struct ProjectRow: View {
    let project: WatchSnapshot.Project

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(project.isLive ? Theme.ok : Theme.line)
                .frame(width: 7, height: 7)
                .accessibilityLabel(project.isLive ? "live" : "idle")
            VStack(alignment: .leading, spacing: 1) {
                Text(project.name)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                Text(project.todayTokens.map { "today \(Format.tokens($0))" } ?? "today —")
                    .font(Theme.data(12))
                    .foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
            if let pause = project.pause {
                Image(systemName: pause == .hard ? "snowflake" : "pause.fill")
                    .foregroundStyle(Theme.color(pause))
                    .imageScale(.small)
            }
        }
        .opacity(project.isLive ? 1 : Theme.staleFade)
    }
}
