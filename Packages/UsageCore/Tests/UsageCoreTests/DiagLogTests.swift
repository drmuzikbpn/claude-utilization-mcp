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
}
