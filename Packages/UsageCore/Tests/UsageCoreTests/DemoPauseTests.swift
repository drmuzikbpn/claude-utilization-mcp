// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Testing
@testable import UsageCore

struct DemoPauseTests {
    let devices = [
        device("m1", sessions: [
            session("s1", projectKey: "/a/.git"),
            session("s2", projectKey: "/a/.git"),
            session("s3", projectKey: "/b/.git"),
        ]),
        device("m2", sessions: [session("s4", projectKey: "/a/.git")]),
    ]

    func visual(_ target: PauseTarget, _ devices: [DeviceState]) -> PauseVisual {
        PauseVisuals.visual(target, team: TeamState(devices: devices), now: t0)
    }

    @Test func pausingASessionPausesOnlyThatSession() {
        let next = DemoPause.apply(.session(deviceId: "m1", sessionId: "s1"), mode: .soft, to: devices, now: t0)
        #expect(visual(.session(deviceId: "m1", sessionId: "s1"), next).isPaused)
        #expect(!visual(.session(deviceId: "m1", sessionId: "s2"), next).isPaused)
        #expect(next[1] == devices[1])
    }

    @Test func aProjectCoversItsSessionsOnItsDeviceOnly() {
        let next = DemoPause.apply(.project(deviceId: "m1", projectKey: "/a/.git"), mode: .soft, to: devices, now: t0)
        #expect(next[0].sessions.map { $0.pause != nil } == [true, true, false])
        #expect(visual(.project(deviceId: "m1", projectKey: "/a/.git"), next).isPaused)
        #expect(next[1].sessions[0].pause == nil)
    }

    @Test func freezeIsHardWithThePid() {
        let next = DemoPause.apply(.session(deviceId: "m1", sessionId: "s1"), mode: .hard, to: devices, now: t0)
        #expect(next[0].sessions[0].pause?.mode == .hard)
        #expect(next[0].sessions[0].pause?.frozenPids == [42])
        guard case .frozen = visual(.session(deviceId: "m1", sessionId: "s1"), next) else {
            Issue.record("not frozen")
            return
        }
    }

    @Test func pauseAllThenResumeAllRoundTrips() {
        let paused = DemoPause.apply(.all, mode: .soft, to: devices, now: t0)
        #expect(visual(.all, paused).isPaused)
        #expect(paused.allSatisfy { $0.sessions.allSatisfy { $0.pause != nil } })
        let resumed = DemoPause.apply(.all, mode: nil, to: paused, now: t0)
        #expect(!visual(.all, resumed).isPaused)
        #expect(resumed == devices)
    }

    @Test func resumingAProjectClearsItsRuleAndSessions() {
        var start = devices
        start[0].rules = [rule("project:/a/.git"), rule("session:s3")]
        start = DemoPause.apply(.project(deviceId: "m1", projectKey: "/a/.git"), mode: .soft, to: start, now: t0)
        let next = DemoPause.apply(.project(deviceId: "m1", projectKey: "/a/.git"), mode: nil, to: start, now: t0)
        #expect(!visual(.project(deviceId: "m1", projectKey: "/a/.git"), next).isPaused)
        #expect(next[0].rules.map(\.scope) == ["session:s3"])
    }
}
