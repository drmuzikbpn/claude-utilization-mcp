// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Testing
@testable import UsageCore

struct DiagLogTests {
    func log(limit: Int = 100) -> DiagLog {
        DiagLog(limit: limit, mirror: false, clock: { date("2026-10-02T19:18:04Z") }, timeZone: .gmt)
    }

    @Test func aLineCarriesWhenWhereAndWhat() {
        let log = log()
        log.log(.pairing, "started for studio")
        #expect(log.lines() == ["2026-10-02T19:18:04Z pairing started for studio"])
    }

    @Test func aRepeatIsCountedNotRepeated() {
        let log = log()
        for _ in 0 ..< 3 {
            log.log(.network, "studio.local unreachable")
        }
        log.log(.network, "studio.local answered")
        #expect(log.lines() == [
            "2026-10-02T19:18:04Z network studio.local unreachable ×3",
            "2026-10-02T19:18:04Z network studio.local answered",
        ])
    }

    @Test func keepsOnlyTheNewestLines() {
        let log = log(limit: 3)
        for n in 1 ... 5 {
            log.log(.app, "event \(n)")
        }
        #expect(log.lines().map { $0.suffix(7) } == ["event 3", "event 4", "event 5"])
    }

    @Test func survivesARelaunchThroughItsFile() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "diag-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: file) }
        let first = log()
        first.attach(file: file)
        first.log(.alerts, "UNREACHABLE raised")
        first.log(.alerts, "UNREACHABLE raised")
        // Repeat counts reach the file when the app leaves the foreground.
        first.flush()

        let second = log()
        second.attach(file: file)
        second.log(.app, "launched")
        #expect(second.lines().map { $0.dropFirst(21) } == ["alerts UNREACHABLE raised ×2", "app launched"])

        second.clear()
        #expect(second.lines().isEmpty)
        #expect(try String(contentsOf: file, encoding: .utf8).isEmpty)
    }

    @Test func describesAnErrorByItsCodeNeverItsText() {
        #expect(DiagLog.describe(URLError(.notConnectedToInternet)) == "URLError -1009")
        #expect(DiagLog.describe(DaemonError(code: "unauthorized", httpStatus: 401, message: "secret")) == "unauthorized (HTTP 401)")
        #expect(DiagLog.describe(DaemonError.network) == "network")
        #expect(DiagLog.describe(CancellationError()) == "CancellationError")
    }

    @Test func aDaemonsErrorCodeIsLoggedOnlyWhenItLooksLikeOne() {
        #expect(DiagLog.describe(DaemonError(code: "rate_limited", httpStatus: 429)) == "rate_limited (HTTP 429)")
        #expect(DiagLog.describe(DaemonError(code: "http_502", httpStatus: 502)) == "http_502 (HTTP 502)")
        for code in ["", "Not Found", "x\ny", "UPPER", String(repeating: "a", count: 41), "a-b", "tok=abc123"] {
            #expect(DiagLog.describe(DaemonError(code: code, httpStatus: 400)) == "unknown (HTTP 400)", "\(code)")
        }
    }

    @Test func aLineIsAlwaysOneLine() {
        let log = log()
        log.log(.pairing, "paired \(DiagLog.name("stu\ndio\r\u{1B}[0m")) then\nforged line\u{2028}x")
        #expect(log.lines() == ["2026-10-02T19:18:04Z pairing paired studio[0m then forged line x"])
    }

    @Test func namesAndHostsAreWrittenCleanAndCapped() {
        #expect(DiagLog.plain(DiagLog.name(String(repeating: "n", count: 200))).count == 64)
        #expect(DiagLog.plain(DiagLog.host("stu\ndio.local")) == "studio.local")
    }

    @Test func anExportRedactsAddressesAndNamesByDefault() {
        let log = log()
        log.log(.pairing, "redeeming for \(DiagLog.name("studio")), 2 address(es)")
        log.log(.network, "\(DiagLog.host("192.0.2.20")) failed: URLError -1004 → network")
        log.log(.network, "\(DiagLog.host("studio.local")) answers")
        log.log(.device, "\(DiagLog.name("studio")) fresh → dead, last heard 130 s ago")
        log.log(.network, "\(DiagLog.host("192.0.2.20")) answers")
        #expect(log.export().split(separator: "\n").map { $0.dropFirst(21) } == [
            "pairing redeeming for device-1, 2 address(es)",
            "network host-1 failed: URLError -1004 → network",
            "network host-2 answers",
            "device device-1 fresh → dead, last heard 130 s ago",
            "network host-1 answers",
        ])
        let full = log.export(redacting: false)
        #expect(full.contains("studio.local answers") && full.contains("192.0.2.20 failed"))
        #expect(!full.unicodeScalars.contains { $0.properties.generalCategory == .privateUse })
    }

    @Test func anExportAlsoRedactsAddressesNobodyMarked() {
        let log = log()
        log.log(.network, "198.51.100.7 answers, so does attic.example.test and 2001:db8::1")
        log.log(.app, "launched 0.1 (10011), iOS Version 18.5 (Build 22F76), 2 paired")
        let lines = log.export().split(separator: "\n").map { String($0.dropFirst(21)) }
        #expect(lines[0] == "network <address> answers, so does <host> and <address>")
        #expect(lines[1] == "app launched 0.1 (10011), iOS Version 18.5 (Build 22F76), 2 paired")
    }

    @Test func whatIsShownOnTheDeviceIsNeverMarked() {
        let log = log()
        log.log(.device, "\(DiagLog.name("studio")) at \(DiagLog.host("studio.local"))")
        #expect(log.text == "2026-10-02T19:18:04Z device studio at studio.local")
    }

    @Test func anAlertIsLoggedByKindAndKeyWithoutAnythingPersonal() {
        #expect(DiagLog.safeKey("WARN|uuid-1/org-2|weekly_all") == "WARN|uuid-1/org-2|weekly_all")
        #expect(DiagLog.safeKey("WARN|sam@example.test|session") == "WARN|…|session")
        #expect(DiagLog.safeKey("FROZEN|d1|" + String(repeating: "s", count: 81)) == "FROZEN|d1|…")
        #expect(DiagLog.safeKey("REPAIR|d 1\nx") == "REPAIR|…")
    }
}
