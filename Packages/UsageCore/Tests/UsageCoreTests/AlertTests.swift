import Foundation
import Testing
@testable import UsageCore

struct AlertEvaluatorTests {
    let evaluator = AlertEvaluator(timeZone: TimeZone(identifier: "UTC")!)

    func team(_ devices: DeviceState...) -> TeamState {
        TeamState(devices: devices)
    }

    func alanWith(_ limits: [Limit], id: String = "m1", user: User = alan) -> DeviceState {
        device(id, user: user, limits: limits, limitsFetchedAt: t0)
    }

    @Test func crossingWarnRaisesOneWarnAlert() throws {
        let reset = date("2026-09-18T09:00:00Z")
        let alerts = evaluator.evaluate(
            previous: team(alanWith([limit("weekly_all", 79, resetsAt: reset)])),
            next: team(alanWith([limit("weekly_all", 81, resetsAt: reset)]))
        )
        let alert = try #require(alerts.first)
        #expect(alerts.count == 1)
        #expect(alert.kind == .warn)
        #expect(alert.key == "WARN|uuid-alan|weekly_all")
        #expect(alert.body == "Alan 7-day at 81% · resets Fri 09:00")
    }

    @Test func stayingAboveWarnRaisesNothing() {
        #expect(evaluator.evaluate(previous: team(alanWith([limit("weekly_all", 81)])), next: team(alanWith([limit("weekly_all", 82)])))
            .isEmpty)
    }

    @Test func firstSightAboveWarnRaisesWarn() {
        let alerts = evaluator.evaluate(previous: nil, next: team(alanWith([limit("weekly_all", 81)])))
        #expect(alerts.map(\.kind) == [.warn])
        #expect(alerts.first?.body == "Alan 7-day at 81% · resets: unknown")
    }

    @Test func crossingCriticalRaisesCriticalNotWarn() {
        let alerts = evaluator.evaluate(
            previous: team(alanWith([limit("weekly_all", 81)])),
            next: team(alanWith([limit("weekly_all", 96)]))
        )
        #expect(alerts.map(\.key) == ["CRITICAL|uuid-alan|weekly_all"])
        #expect(alerts.first?.body.hasPrefix("Alan 7-day at 96%") == true)
    }

    @Test func firstSightAlreadyCriticalRaisesCriticalOnly() {
        let alerts = evaluator.evaluate(previous: nil, next: team(alanWith([limit("session", 99, resetsAt: date("2026-09-13T16:35:00Z"))])))
        #expect(alerts.map(\.kind) == [.critical])
        #expect(alerts.first?.body == "Alan 5-hour at 99% · resets Sun 16:35")
    }

    @Test func scopedLimitsAreNamedByTheirModel() {
        let scoped = limit("weekly_scoped:fable", 96, kind: "weekly_scoped", model: "Fable")
        #expect(evaluator.evaluate(previous: nil, next: team(alanWith([scoped]))).first?.body.hasPrefix("Alan Fable at 96%") == true)
    }

    @Test func droppingBelowWarnRaisesNothing() {
        #expect(evaluator.evaluate(previous: team(alanWith([limit("weekly_all", 96)])), next: team(alanWith([limit("weekly_all", 4)])))
            .isEmpty)
    }

    @Test func bothUsersCrossingAtOnceProduceTwoAlerts() {
        let before = team(alanWith([limit("weekly_all", 10)]), alanWith([limit("weekly_all", 10)], id: "m2", user: jamie))
        let after = team(alanWith([limit("weekly_all", 85)]), alanWith([limit("weekly_all", 85)], id: "m2", user: jamie))
        #expect(Set(evaluator.evaluate(previous: before, next: after).map(\.key)) == [
            "WARN|uuid-alan|weekly_all",
            "WARN|uuid-jamie|weekly_all",
        ])
    }

    @Test func aSessionEnteringHardFreezeRaisesFrozen() throws {
        let frozen = PauseState(mode: .hard, ruleId: "r-1", scope: "session:s1", since: t0, frozenPids: [42])
        let soft = PauseState(mode: .soft, ruleId: "r-1", scope: "session:s1", since: t0, frozenPids: [])
        let alerts = evaluator.evaluate(
            previous: team(device("m1", user: alan, sessions: [session("s1", projectName: "calendarpa", pause: soft)])),
            next: team(device("m1", user: alan, sessions: [session("s1", projectName: "calendarpa", pause: frozen)]))
        )
        let alert = try #require(alerts.first)
        #expect(alert.kind == .frozen)
        #expect(alert.key == "FROZEN|m1|s1")
        #expect(alert.body.contains("calendarpa"))
        #expect(alert.window == nil)
    }

    @Test func aSessionThatStaysFrozenRaisesNothing() {
        let frozen = PauseState(mode: .hard, ruleId: "r-1", scope: "session:s1", since: t0, frozenPids: [42])
        let state = team(device("m1", user: alan, sessions: [session("s1", pause: frozen)]))
        #expect(evaluator.evaluate(previous: state, next: state).isEmpty)
    }

    @Test func aDeviceGoingDeadRaisesUnreachableOnceAndSaysDevice() throws {
        let after = team(device("m1", user: alan, health: .dead))
        let alert = try #require(evaluator.evaluate(previous: team(device("m1", user: alan, health: .stale)), next: after).first)
        #expect(alert.kind == .unreachable)
        #expect(alert.key == "UNREACHABLE|m1")
        #expect(alert.title == "Device unreachable")
        #expect(alert.body.contains("m1"))
        #expect(evaluator.evaluate(previous: after, next: after).isEmpty)
    }

    @Test func aDeviceThatStartsDeadRaisesNothing() {
        #expect(evaluator.evaluate(previous: nil, next: team(device("m1", health: .dead))).isEmpty)
    }

    @Test func thresholdsAreConfigurable() {
        let strict = AlertEvaluator(thresholds: AlertThresholds(warn: 50, critical: 60), timeZone: .gmt)
        #expect(strict.evaluate(previous: team(alanWith([limit("weekly_all", 40)])), next: team(alanWith([limit("weekly_all", 55)])))
            .map(\.kind) == [.warn])
    }

    @Test func aLimitAlertCarriesItsWindowSoItCanBeAnnouncedOnce() {
        let at = date("2026-09-23T13:00:00Z")
        let alert = evaluator.evaluate(previous: nil, next: team(alanWith([limit("weekly_all", 96, resetsAt: at)]))).first
        #expect(alert?.window == Int64(at.timeIntervalSince1970 * 1000))
        #expect(evaluator.evaluate(previous: nil, next: team(alanWith([limit("weekly_all", 96)]))).first?.window == nil)
    }

    @Test func renamesNameTheAccount() {
        let named = AlertEvaluator(timeZone: .gmt, nameFor: { _ in "Boss" })
        #expect(named.evaluate(previous: nil, next: team(alanWith([limit("weekly_all", 81)]))).first?.body.hasPrefix("Boss 7-day") == true)
    }

    @Test func clearedListsTheKeysUnderEachThreshold() {
        let keys = evaluator.cleared(team(alanWith([limit("weekly_all", 85), limit("session", 4)])))
        #expect(Set(keys) == ["CRITICAL|uuid-alan|weekly_all", "CRITICAL|uuid-alan|session", "WARN|uuid-alan|session"])
    }
}

struct AlertLedgerTests {
    let defaults = UserDefaults(suiteName: "alert-ledger-\(UUID().uuidString)")!
    let key = "WARN|alan/org-1|weekly_all"
    let window: Int64 = 1_760_000_000_000

    @Test func aWindowAnnouncesItselfOnce() {
        let ledger = AlertLedger(defaults: defaults)
        #expect(ledger.markFired(key, window: window))
        #expect(!ledger.markFired(key, window: window))
    }

    @Test func theLedgerSurvivesARelaunch() {
        #expect(AlertLedger(defaults: defaults).markFired(key, window: window))
        #expect(!AlertLedger(defaults: defaults).markFired(key, window: window))
    }

    @Test func theNextWindowIsNewsAgain() {
        let ledger = AlertLedger(defaults: defaults)
        #expect(ledger.markFired(key, window: window))
        #expect(ledger.markFired(key, window: window + 604_800_000))
    }

    @Test func fallingBackUnderTheThresholdForgetsTheCrossing() {
        let ledger = AlertLedger(defaults: defaults)
        #expect(ledger.markFired(key, window: window))
        ledger.forget(key)
        #expect(ledger.markFired(key, window: window))
    }

    @Test func twoLimitsOnOneAccountAreTrackedApart() {
        let ledger = AlertLedger(defaults: defaults)
        #expect(ledger.markFired(key, window: window))
        #expect(ledger.markFired("WARN|alan/org-1|session", window: window))
    }

    @Test func admitGatesLimitAlertsAndPassesEvents() {
        let ledger = AlertLedger(defaults: defaults)
        let limitAlert = Alert(kind: .warn, key: key, title: "", body: "", window: window)
        let unknownWindow = Alert(kind: .warn, key: "WARN|x|y", title: "", body: "")
        let frozen = Alert(kind: .frozen, key: "FROZEN|m1|s1", title: "", body: "")
        #expect(ledger.admit([limitAlert, unknownWindow, frozen]).count == 3)
        #expect(ledger.admit([limitAlert, unknownWindow, frozen]).map(\.key) == ["WARN|x|y", "FROZEN|m1|s1"])
    }
}
