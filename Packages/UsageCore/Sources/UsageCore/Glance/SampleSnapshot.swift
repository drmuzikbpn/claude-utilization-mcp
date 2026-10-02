import Foundation

public extension WatchSnapshot {
    /// Made-up data for widget placeholders, the widget gallery, SwiftUI previews and the watch's
    /// debug screenshots. Contains no real names, prompts or credentials.
    static func sample(now: Date) -> WatchSnapshot {
        let minute: TimeInterval = 60
        let burn = (0 ..< sparklineBuckets).map { i in
            let x = Double(i) / Double(sparklineBuckets - 1)
            return 1200 + 2600 * x * x + 600 * sin(x * 9)
        }
        return WatchSnapshot(
            generatedAt: now,
            accounts: [
                Account(
                    key: "sample-work/org",
                    name: "Work",
                    fiveHour: Headline(percent: 82, resetsAt: now.addingTimeInterval(96 * minute), status: .warn),
                    sevenDay: Headline(percent: 41, resetsAt: now.addingTimeInterval(3 * 86400 + 5 * 3600), status: .ok),
                    fetchedAt: now.addingTimeInterval(-12),
                    health: .fresh
                ),
                Account(
                    key: "sample-home/org",
                    name: "Home",
                    fiveHour: Headline(percent: 23, resetsAt: now.addingTimeInterval(212 * minute), status: .ok),
                    sevenDay: Headline(percent: 67, resetsAt: now.addingTimeInterval(86400 + 2 * 3600), status: .ok),
                    fetchedAt: now.addingTimeInterval(-40),
                    health: .stale
                ),
            ],
            devices: [
                Device(id: "studio", name: "studio", health: .fresh, lastSeenAt: now, needsRepair: false, pausedAll: false),
                Device(id: "laptop", name: "laptop", health: .fresh, lastSeenAt: now, needsRepair: false, pausedAll: false),
            ],
            projects: [
                Project(
                    deviceId: "studio",
                    key: "/code/usage/.git",
                    name: "usage",
                    todayTokens: 4_200_000,
                    liveTokens: 380_000,
                    ratePerMin: 3800,
                    burn: burn,
                    sessions: [
                        SessionRow(
                            id: "7f3a9c21-sample",
                            label: "watch app",
                            model: "opus",
                            tokens: 310_000,
                            ratePerMin: 2900,
                            pause: nil,
                            freezes: 0,
                            canHardPause: true,
                            startedAt: now.addingTimeInterval(-74 * minute),
                            lastTool: "Edit"
                        ),
                        SessionRow(
                            id: "b81e0d44-sample",
                            label: "b81e…",
                            model: "sonnet",
                            tokens: 70000,
                            ratePerMin: 900,
                            pause: .soft,
                            freezes: 0,
                            canHardPause: true,
                            startedAt: now.addingTimeInterval(-22 * minute),
                            lastTool: "Bash"
                        ),
                    ],
                    pause: nil
                ),
                Project(
                    deviceId: "laptop",
                    key: "/code/site/.git",
                    name: "site",
                    todayTokens: 1_100_000,
                    liveTokens: 90000,
                    ratePerMin: 640,
                    burn: burn.map { $0 * 0.3 },
                    sessions: [
                        SessionRow(
                            id: "c0ffee12-sample",
                            label: "c0ff…",
                            model: "haiku",
                            tokens: 90000,
                            ratePerMin: 640,
                            pause: .hard,
                            freezes: 1,
                            canHardPause: true,
                            startedAt: now.addingTimeInterval(-9 * minute),
                            lastTool: "Read"
                        ),
                    ],
                    pause: nil
                ),
                Project(
                    deviceId: "studio",
                    key: "/code/notes/.git",
                    name: "notes",
                    todayTokens: 260_000,
                    liveTokens: 0,
                    ratePerMin: 0,
                    burn: [],
                    sessions: [],
                    pause: nil
                ),
            ],
            teamTodayTokens: 5_560_000,
            liveSessionCount: 3,
            escalations: [Escalation(deviceId: "studio", scope: "session:b81e0d44-sample", fireAt: now.addingTimeInterval(42))],
            use24h: true
        )
    }
}
