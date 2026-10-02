import Foundation
import Testing
@testable import UsageCore

struct FormatTests {
    let london = TimeZone(identifier: "Europe/London")!
    /// 2026-09-13 is a Sunday; 14:02 local (BST = UTC+1).
    let now = date("2026-09-13T13:02:00Z")

    @Test func frozenTagReadsFrozenOnceAndFrozenAgainWithACount() {
        #expect(Format.frozenTag(0) == "frozen")
        #expect(Format.frozenTag(1) == "frozen")
        #expect(Format.frozenTag(2) == "frozen again ×2")
        #expect(Format.frozenTag(5) == "frozen again ×5")
    }

    @Test func tokensAbbreviate() {
        #expect(Format.tokens(0) == "0")
        #expect(Format.tokens(999) == "999")
        #expect(Format.tokens(4200) == "4.2k")
        #expect(Format.tokens(1_200_000) == "1.2M")
        #expect(Format.tokens(12_400_000) == "12.4M")
        #expect(Format.tokens(38000) == "38k")
        #expect(Format.tokens(1000) == "1k")
        #expect(Format.tokens(2_000_000) == "2M")
        #expect(Format.tokens(999_999) == "1M", "promotes rather than printing a four-digit k")
        #expect(Format.tokens(3_055_500_000) == "3.1B")
        #expect(Format.tokens(999_940_000) == "999.9M")
        #expect(Format.tokens(-5) == "0")
    }

    @Test func ratePerMinRoundsAndSuffixes() {
        #expect(Format.ratePerMin(38000) == "38k/min")
        #expect(Format.ratePerMin(0) == "0/min")
        #expect(Format.ratePerMin(412) == "412/min")
        #expect(Format.ratePerMin(412.6) == "413/min")
        #expect(Format.ratePerMin(-3) == "0/min")
    }

    @Test func resetsRendersEveryCase() {
        #expect(Format.resets(nil, now: now, timeZone: london) == "resets: unknown")
        #expect(Format.resets(date("2026-09-13T15:35:00Z"), now: now, timeZone: london) == "resets 16:35 · 2h33")
        #expect(Format.resets(date("2026-09-13T13:09:00Z"), now: now, timeZone: london) == "resets 14:09 · 7m")
        #expect(Format.resets(date("2026-09-17T08:00:00Z"), now: now, timeZone: london) == "resets Thu 09:00")
        #expect(Format.resets(date("2026-09-13T12:00:00Z"), now: now, timeZone: london) == "resets 13:00 · 0m")
    }

    @Test func resetCountdownShowsTheTwoLargestUnits() {
        #expect(Format.resetCountdown(now.addingTimeInterval(2 * 86400 + 3 * 3600 + 59 * 60), now: now) == "2d03h")
        #expect(Format.resetCountdown(now.addingTimeInterval(3600 + 36 * 60 + 12), now: now) == "1h36m")
        #expect(Format.resetCountdown(now.addingTimeInterval(36 * 60 + 12), now: now) == "36m12s")
        #expect(Format.resetCountdown(now.addingTimeInterval(-5), now: now) == "due")
        #expect(Format.resetCountdown(now, now: now) == "due")
        #expect(Format.resetCountdown(nil, now: now) == "—")
    }

    @Test func countdownIsMinutesAndPaddedSecondsFlooredAtZero() {
        #expect(Format.countdown(now.addingTimeInterval(42), now: now) == "0:42")
        #expect(Format.countdown(now.addingTimeInterval(725), now: now) == "12:05")
        #expect(Format.countdown(now.addingTimeInterval(-5), now: now) == "0:00")
    }

    @Test func shortIdAndAge() {
        #expect(Format.shortId("a1b2c3d4-e5f6") == "a1b2…")
        #expect(Format.shortId("abc") == "abc…")
        #expect(Format.age(now.addingTimeInterval(-4), now: now) == "4s ago")
        #expect(Format.age(now.addingTimeInterval(-180), now: now) == "3m ago")
        #expect(Format.age(now.addingTimeInterval(-7200), now: now) == "2h ago")
        #expect(Format.age(now.addingTimeInterval(-3 * 86400), now: now) == "3d ago")
        #expect(Format.age(nil, now: now) == "never")
        #expect(Format.age(now.addingTimeInterval(30), now: now) == "0s ago")
    }

    @Test func twelveHourClockVariants() {
        let thursday = date("2026-09-17T08:00:00Z")
        let soon = date("2026-09-13T15:35:00Z")
        #expect(Format.resetsShort(thursday, now: now, timeZone: london, use24h: false) == "Thu 9:00 AM")
        #expect(Format.resets(thursday, now: now, timeZone: london, use24h: false) == "resets Thu 9:00 AM")
        #expect(Format.resets(soon, now: now, timeZone: london, use24h: false) == "resets 4:35 PM · 2h33")
    }

    @Test func resetAtUsesTheWeekdayOnlyADayOrMoreAway() {
        let thursday = date("2026-09-17T08:00:00Z")
        let soon = date("2026-09-13T15:35:00Z")
        #expect(Format.resetAt(soon, now: now, timeZone: london, use24h: true) == "16:35")
        #expect(Format.resetAt(soon, now: now, timeZone: london, use24h: false) == "4:35 PM")
        #expect(Format.resetAt(thursday, now: now, timeZone: london, use24h: true) == "Thu 09:00")
        #expect(Format.resetAt(thursday, now: now, timeZone: london, use24h: false) == "Thu 9:00 AM")
        #expect(Format.resetAt(nil, now: now, timeZone: london) == "—")
        // Exactly 24 h away is "a day or more".
        #expect(Format.resetAt(now.addingTimeInterval(86400), now: now, timeZone: london) == "Mon 14:02")
    }

    @Test func resetsShortIsASpanInsideADay() {
        let now = date("2026-09-13T14:02:00Z")
        #expect(Format.resetsShort(now.addingTimeInterval(2 * 3600 + 33 * 60), now: now, timeZone: .gmt) == "2h33 left")
        #expect(Format.resetsShort(date("2026-09-17T09:00:00Z"), now: now, timeZone: .gmt) == "Thu 09:00")
        #expect(Format.resetsShort(nil, now: now, timeZone: .gmt) == "unknown")
    }

    @Test func modelIdsShortenToTheirFamilyAndHostsDropTheirDomain() {
        #expect(Format.modelShort("claude-opus-5") == "opus")
        #expect(Format.modelShort("claude-fable-5-1") == "fable")
        #expect(Format.modelShort("claude-haiku-4-5-20251001") == "haiku")
        #expect(Format.modelShort("gpt") == "gpt")
        #expect(Format.modelShort(nil) == nil)
        #expect(Format.hostShort("macbook-pro-10.tail0fake.ts.net") == "macbook-pro-10")
        #expect(Format.hostShort("studio") == "studio")
    }

    @Test func theClockRenders24Or12Hour() throws {
        let at = date("2026-09-13T22:21:00Z")
        let ny = try #require(TimeZone(identifier: "America/New_York"))
        #expect(Format.clock(at, timeZone: ny, use24h: true) == "18:21")
        #expect(Format.clock(at, timeZone: ny, use24h: false) == "6:21 PM")
    }
}
