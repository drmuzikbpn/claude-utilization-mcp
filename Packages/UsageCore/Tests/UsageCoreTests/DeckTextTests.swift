// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Testing
@testable import UsageCore

/// Which copy may be drawn as Markdown: only text written in this app's source.
struct DeckTextTests {
    @Test func aLiteralIsTheOnlyTextThatMayCarryMarkdown() {
        let text = DeckText.literal("Run `claude-usage pair` on the device.")
        #expect(text.segments.map(\.isMarkdown) == [true])
        #expect(text.isTrusted)
        #expect(text.plain == "Run `claude-usage pair` on the device.")
    }

    @Test func textFromOutsideIsAlwaysVerbatim() {
        let hostile = "**studio** [tap](https://example.test) `x`"
        let text = DeckText.untrusted(hostile)
        #expect(text.segments.map(\.isMarkdown) == [false])
        #expect(!text.isTrusted)
        #expect(text.plain == hostile)
    }

    @Test func mixingKeepsEachPartsTrust() {
        let text = DeckText.literal("On ") + .untrusted("[studio](https://example.test)") + .literal(", run `claude-usage pair`.")
        #expect(text.segments.map(\.isMarkdown) == [true, false, true])
        #expect(text.segments[1].text == "[studio](https://example.test)")
        #expect(!text.isTrusted)
        #expect(text.plain == "On [studio](https://example.test), run `claude-usage pair`.")
    }

    @Test func aDaemonErrorIsNeverTrusted() {
        let error = DaemonError(code: "forbidden", httpStatus: 403, message: "**no**", hint: "[re-pair](https://example.test)")
        #expect(error.displayText.segments.map(\.isMarkdown) == [false])
        #expect(error.displayText.plain == "[re-pair](https://example.test)")
        // Our own per-code defaults go the same way: one rule for everything a device can cause.
        #expect(!DaemonError(code: "unauthorized").displayText.isTrusted)
    }

    @Test func everyPairingRejectionKeepsWhatWasScannedOutOfMarkdown() {
        let inputs = [
            "hello",
            "usagedeck://pair?v=9&name=**x**",
            "usagedeck://pair?v=2&name=studio&addrs=[a](https://example.test)&port=1&fp=0&code=0",
            #"{"v":1,"name":"studio","addr":"bad host","port":47291,"token":"t"}"#,
            #"{"v":7,"name":"studio","addr":"studio.local","port":47291,"token":"t"}"#,
        ]
        for input in inputs {
            guard case let .rejected(text) = PairingInput.classify(input) else {
                Issue.record("expected a rejection for \(input)")
                continue
            }
            for segment in text.segments where segment.isMarkdown {
                #expect(!segment.text.contains("example.test"))
                #expect(!segment.text.contains("**x**"))
            }
            #expect(!text.plain.contains("example.test"), "the offending value is not echoed")
            #expect(!text.plain.contains("bad host"), "the offending value is not echoed")
        }
    }
}

struct DeviceNameTests {
    @Test func stripsControlAndFormatCharacters() {
        #expect(DeviceName.clean("stu\ndio\r\u{0}\u{1B}[31m") == "studio[31m")
        #expect(DeviceName.clean("a\u{202E}b\u{200B}c\u{2028}d") == "abcd")
        #expect(DeviceName.clean("  studio \t") == "studio")
    }

    @Test func capsAt64Characters() {
        #expect(DeviceName.clean(String(repeating: "x", count: 200)).count == 64)
        #expect(DeviceName.clean(String(repeating: "é", count: 70)) == String(repeating: "é", count: 64))
    }

    @Test func keepsOrdinaryNames() {
        #expect(DeviceName.clean("Sam's Studio (2)") == "Sam's Studio (2)")
        #expect(DeviceName.clean("studio.local") == "studio.local")
    }
}
