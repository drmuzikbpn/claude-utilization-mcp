import SwiftUI
import UsageCore

/// One project: today / tok/min / share, the 5 h burn sparkline, its live sessions each with a
/// pause control, and Pause project at the bottom.
struct ProjectDetailView: View {
    @Environment(PhoneLink.self) private var link
    let projectId: String

    var body: some View {
        let snapshot = link.snapshot ?? .empty
        ScrollView {
            if let project = snapshot.projects.first(where: { $0.id == projectId }) {
                content(project, snapshot: snapshot)
            } else {
                Text("This project is no longer reported")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
        }
        .navigationTitle(snapshot.projects.first { $0.id == projectId }?.name ?? "Project")
        .containerBackground(Theme.ground.gradient, for: .navigation)
    }

    private func content(_ project: WatchSnapshot.Project, snapshot: WatchSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !link.reachable {
                UnreachableBanner()
            }
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Figure(value: project.todayTokens.map(Format.tokens) ?? "—", label: "today")
                Figure(value: Format.tokens(Int64(project.ratePerMin.rounded())), label: "tok/min")
                Figure(value: snapshot.share(of: project).map { "\($0)%" } ?? "—", label: "share")
            }
            if project.burn.count > 1 {
                VStack(alignment: .leading, spacing: 1) {
                    Sparkline(values: project.burn)
                        .frame(height: 30)
                    Text("last 5 h")
                        .font(Theme.data(10))
                        .foregroundStyle(Theme.muted)
                }
            }
            if project.sessions.isEmpty {
                Text("No live sessions")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            ForEach(project.sessions) { session in
                SessionRowView(session: session, deviceId: project.deviceId, snapshot: snapshot)
            }
            PauseControl(
                target: project.target,
                idleTitle: "Pause project",
                canHardPause: project.sessions.allSatisfy(\.canHardPause),
                style: .wide
            )
            .padding(.top, 4)
        }
        .padding(.horizontal, 2)
        .opacity(link.reachable ? 1 : Theme.staleFade)
    }
}

private struct Figure: View {
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 0) {
            Text(value)
                .font(Theme.numeral(22))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(Theme.data(10))
                .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

private struct SessionRowView: View {
    @Environment(PhoneLink.self) private var link
    @Environment(\.isLuminanceReduced) private var systemLuminanceReduced
    private var isLuminanceReduced: Bool {
        AlwaysOn.dimmed(systemLuminanceReduced)
    }

    let session: WatchSnapshot.SessionRow
    let deviceId: String
    let snapshot: WatchSnapshot

    var body: some View {
        let target = session.target(deviceId: deviceId)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(Format.shortId(session.id))
                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    if session.label != Format.shortId(session.id) {
                        Text(session.label)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                PauseControl(target: target, canHardPause: session.canHardPause, freezes: session.freezes)
            }
            Text(details)
                .font(Theme.data(11))
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
            if let escalation = snapshot.escalation(for: target), !isLuminanceReduced {
                EscalationCountdown(escalation: escalation)
            }
            if let failure = link.failures[target] {
                FailureText(text: failure)
            }
        }
        .padding(8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
    }

    private var details: String {
        var parts: [String] = []
        if let startedAt = session.startedAt {
            parts.append("since \(Format.clock(startedAt, use24h: snapshot.use24h))")
        }
        if let tool = session.lastTool {
            parts.append(tool)
        }
        if let model = session.model {
            parts.append(model)
        }
        return parts.isEmpty ? Format.tokens(session.tokens) : parts.joined(separator: " · ")
    }
}

/// Tokens/min over the last 5 h, oldest first, in the accent colour.
struct Sparkline: View {
    let values: [Double]

    var body: some View {
        Canvas { context, size in
            let peak = max(values.max() ?? 0, 1)
            let step = size.width / CGFloat(max(values.count - 1, 1))
            var line = Path()
            for (i, v) in values.enumerated() {
                let point = CGPoint(x: CGFloat(i) * step, y: size.height * (1 - CGFloat(v / peak)))
                if i == 0 {
                    line.move(to: point)
                } else {
                    line.addLine(to: point)
                }
            }
            var fill = line
            fill.addLine(to: CGPoint(x: size.width, y: size.height))
            fill.addLine(to: CGPoint(x: 0, y: size.height))
            fill.closeSubpath()
            context.fill(fill, with: .color(Theme.accent.opacity(0.18)))
            context.stroke(line, with: .color(Theme.accent), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }
        .accessibilityLabel("burn over the last five hours")
    }
}
