// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// "Try the demo" has no daemon to call, so its pause controls change the made-up devices in
/// place: the rows, the project and Pause all show exactly what a real pause would.
public enum DemoPause {
    /// `mode` nil resumes. Pausing sets the target's sessions (and, for `.all`, an `all` rule on
    /// every device); resuming clears every pause and rule the target covers.
    public static func apply(_ target: PauseTarget, mode: PauseMode?, to devices: [DeviceState], now: Date) -> [DeviceState] {
        devices.map { device in
            guard target.deviceId == nil || target.deviceId == device.id else { return device }
            var next = device
            for index in next.sessions.indices where covers(target, next.sessions[index]) {
                let pid = next.sessions[index].pid
                next.sessions[index].pause = mode.map { mode in
                    PauseState(
                        mode: mode,
                        ruleId: "demo-\(target.scope)",
                        scope: target.scope,
                        since: now,
                        frozenPids: mode == .hard ? pid.map { [$0] } ?? [] : [],
                        freezes: mode == .hard ? 1 : 0
                    )
                }
            }
            next.rules.removeAll { covers(target, scope: $0.scope) }
            if let mode, target == .all {
                next.rules.append(PauseRule(id: "demo-all", scope: "all", mode: mode, reason: nil, createdAt: now, createdBy: "demo"))
            }
            return next
        }
    }

    private static func covers(_ target: PauseTarget, _ session: Session) -> Bool {
        switch target {
        case let .session(_, sessionId): session.sessionId == sessionId
        case let .project(_, projectKey): session.projectKey == projectKey
        case .all: true
        }
    }

    private static func covers(_ target: PauseTarget, scope: String) -> Bool {
        target == .all || scope == target.scope
    }
}
