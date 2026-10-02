import Foundation
import Testing
@testable import UsageCore

struct AgingTests {
    @Test func nilHeartbeatIsDead() {
        #expect(Aging.health(lastHeartbeatAt: nil, now: t0) == .dead)
    }

    @Test func boundariesAre30And120Seconds() {
        #expect(Aging.health(lastHeartbeatAt: t0.addingTimeInterval(-29), now: t0) == .fresh)
        #expect(Aging.health(lastHeartbeatAt: t0.addingTimeInterval(-30), now: t0) == .stale)
        #expect(Aging.health(lastHeartbeatAt: t0.addingTimeInterval(-119), now: t0) == .stale)
        #expect(Aging.health(lastHeartbeatAt: t0.addingTimeInterval(-120), now: t0) == .dead)
    }

    @Test func aHeartbeatInTheFutureIsFresh() {
        #expect(Aging.health(lastHeartbeatAt: t0.addingTimeInterval(5), now: t0) == .fresh)
    }
}

struct BurnHistoryTests {
    @Test func rateOverA60SecondWindow() {
        let h = BurnHistory()
        h.record("s", at: t0, cumulative: 1000)
        h.record("s", at: t0.addingTimeInterval(60), cumulative: 4000)
        #expect(abs(h.ratePerMinute("s", now: t0.addingTimeInterval(60)) - 3000) < 0.01)
    }

    @Test func theRateLooksBackFiveMinutesSoAQuietMinuteStillReadsBusy() {
        let h = BurnHistory()
        h.record("s", at: t0, cumulative: 0)
        h.record("s", at: t0.addingTimeInterval(200), cumulative: 20000)
        h.record("s", at: t0.addingTimeInterval(270), cumulative: 20000)
        #expect(abs(h.ratePerMinute("s", now: t0.addingTimeInterval(270)) - 20000 / 4.5) < 0.01)
        #expect(h.ratePerMinute("s", now: t0.addingTimeInterval(270 + 300)) == 0)
    }

    @Test func rateIsZeroWithOneSampleOrUnknownKey() {
        let h = BurnHistory()
        h.record("s", at: t0, cumulative: 1000)
        #expect(h.ratePerMinute("s", now: t0) == 0)
        #expect(BurnHistory().ratePerMinute("nope", now: t0) == 0)
    }

    @Test func seriesBucketsTokensPerMinuteOldestFirst() {
        let h = BurnHistory()
        for i in 0 ... 10 {
            h.record("s", at: t0.addingTimeInterval(Double(i) * 60), cumulative: Int64(i) * 600)
        }
        let s = h.series("s", now: t0.addingTimeInterval(600), window: 600, buckets: 5)
        #expect(s.count == 5)
        #expect(s.allSatisfy { abs($0 - 600) < 1 })
    }

    @Test func seriesIsAllZeroesForAnUnknownKey() {
        #expect(BurnHistory().series("nope", now: t0, window: 600, buckets: 4) == [0, 0, 0, 0])
    }

    @Test func aCumulativeDropResetsTheBaselineInsteadOfANegativeRate() {
        let h = BurnHistory()
        h.record("s", at: t0, cumulative: 5000)
        h.record("s", at: t0.addingTimeInterval(30), cumulative: 100)
        h.record("s", at: t0.addingTimeInterval(60), cumulative: 400)
        #expect(abs(h.ratePerMinute("s", now: t0.addingTimeInterval(60)) - 600) < 0.01)
    }

    @Test func pointsOlderThanRetentionAreDropped() {
        let h = BurnHistory(retention: 60)
        h.record("s", at: t0, cumulative: 1)
        h.record("s", at: t0.addingTimeInterval(120), cumulative: 2)
        #expect(h.ratePerMinute("s", now: t0.addingTimeInterval(120)) == 0)
    }

    @Test func maxPointsCapsTheBuffer() {
        let h = BurnHistory(maxPoints: 3)
        for i in 0 ... 9 {
            h.record("s", at: t0.addingTimeInterval(Double(i) * 10), cumulative: Int64(i) * 100)
        }
        // The three newest points span 20 s and 200 tokens.
        #expect(abs(h.ratePerMinute("s", now: t0.addingTimeInterval(90), window: 300) - 600) < 0.01)
    }

    @Test func forgetDropsAKeyAndForgetPrefixDropsADevice() {
        let h = BurnHistory()
        for key in ["d1/s/a", "d1/m", "d2/m"] {
            h.record(key, at: t0, cumulative: 1000)
            h.record(key, at: t0.addingTimeInterval(60), cumulative: 4000)
        }
        h.forget("d1/s/a")
        #expect(h.ratePerMinute("d1/s/a", now: t0.addingTimeInterval(60)) == 0)
        h.forget(prefix: "d1/")
        #expect(h.ratePerMinute("d1/m", now: t0.addingTimeInterval(60)) == 0)
        #expect(h.ratePerMinute("d2/m", now: t0.addingTimeInterval(60)) > 0)
    }

    @Test func readsSurviveConcurrentWrites() async {
        let history = BurnHistory()
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                for i in 0 ..< 5000 {
                    history.record("k", at: t0.addingTimeInterval(Double(i) / 1000), cumulative: Int64(i))
                    if i % 500 == 0 {
                        history.record("k", at: t0.addingTimeInterval(Double(i) / 1000), cumulative: 0)
                    }
                }
            }
            group.addTask {
                for i in 0 ..< 5000 {
                    _ = history.ratePerMinute("k", now: t0.addingTimeInterval(Double(i) / 1000))
                    _ = history.series("k", now: t0.addingTimeInterval(Double(i) / 1000), window: 1800, buckets: 16)
                }
            }
        }
    }
}

struct TypesTests {
    @Test func tokensTotalSumsTheFourCountersNotMessages() {
        #expect(Tokens(input: 1, output: 2, cacheCreate: 3, cacheRead: 4, messages: 99).total == 10)
    }

    @Test func tokensAddFieldwise() {
        let t = Tokens(input: 1, output: 2, cacheCreate: 3, cacheRead: 4, messages: 5)
        #expect(t + t == Tokens(input: 2, output: 4, cacheCreate: 6, cacheRead: 8, messages: 10))
    }

    @Test func canHardPauseRequiresHookDiscoveryAndAPid() {
        #expect(session("s").canHardPause)
        #expect(!session("s", pid: nil).canHardPause)
        #expect(!session("s", discovered: .transcript).canHardPause)
    }
}

struct VersionTests {
    @Test func parsesTheCommitStampedSchemeWithALeadingV() throws {
        let v = try #require(Version.parse("v0.1.417+3f9c2ab"))
        #expect(v.major == 0)
        #expect(v.minor == 1)
        #expect(v.build == 417)
        #expect(v.sha == "3f9c2ab")
        #expect(v.description == "0.1.417+3f9c2ab")
    }

    @Test func parsesWithoutTheVAndWithoutASha() {
        #expect(Version.parse("0.1.417+3f9c2ab")?.sha == "3f9c2ab")
        #expect(Version.parse("0.1.417")?.sha == "")
    }

    @Test(arguments: ["garbage", "", "0.1", "v.x.y+z"])
    func garbageDoesNotParse(text: String) {
        #expect(Version.parse(text) == nil)
    }

    @Test func buildOrdersVersionsAndTheShaIsIgnored() throws {
        let older = try #require(Version.parse("0.1.417+zzzzzzz"))
        let newer = try #require(Version.parse("0.1.418+aaaaaaa"))
        #expect(newer > older)
        #expect(Version.parse("0.1.418+aaaaaaa") == Version.parse("0.1.418+bbbbbbb"))
    }

    @Test func majorAndMinorBeatBuild() throws {
        #expect(try #require(Version.parse("0.2.1")) > #require(Version.parse("0.1.999")))
        #expect(try #require(Version.parse("1.0.0")) > #require(Version.parse("0.9.999")))
    }
}
