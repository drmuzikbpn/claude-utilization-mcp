import Foundation
import Testing
@testable import UsageCore

struct ActivityOrderTests {
    private func project(_ key: String, _ sessions: [String]) -> ProjectView {
        ProjectView(deviceId: "d", key: key, name: key, sessions: sessions.map { session($0) }, todayTokens: nil, worktreeCount: 1)
    }

    @Test func fastestSessionsLeadTheFlatListWhateverTheirProject() {
        let projects = [project("big", ["idle", "slow"]), project("small", ["hot"])]
        let rates = ["idle": 0.0, "slow": 2000, "hot": 1_200_000]
        let rows = ActivityOrder.sessions(projects) { _, s in rates[s.sessionId] ?? 0 }
        #expect(rows.map(\.session.sessionId) == ["hot", "slow", "idle"])
    }

    @Test func projectsAndTheirSessionsRankByRate() {
        let projects = [project("a", ["a1", "a2"]), project("b", ["b1"]), project("gone", [])]
        let sessionRates = ["a1": 10.0, "a2": 50000, "b1": 0]
        let projectRates = ["a": 50010.0, "b": 900_000]
        let ordered = ActivityOrder.projects(
            projects,
            projectRate: { projectRates[$0.key] ?? 0 },
            sessionRate: { _, s in sessionRates[s.sessionId] ?? 0 }
        )
        #expect(ordered.map(\.key) == ["b", "a"])
        #expect(ordered[1].sessions.map(\.sessionId) == ["a2", "a1"])
    }

    @Test func nearlyEqualRatesKeepTheirPlaces() {
        let projects = [project("a", ["first", "second"])]
        let rates = ["first": 298_700.0, "second": 310_000]
        let rows = ActivityOrder.sessions(projects) { _, s in rates[s.sessionId] ?? 0 }
        #expect(rows.map(\.session.sessionId) == ["first", "second"])
        #expect(ActivityOrder.band(0.4) == Int.min)
    }
}
