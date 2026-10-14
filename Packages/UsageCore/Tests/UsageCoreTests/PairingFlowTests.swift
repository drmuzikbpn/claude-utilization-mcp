// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Testing
@testable import UsageCore

/// The pairing sheet's state: what opens it, what a link from outside may and may not do.
struct PairingFlowTests {
    static let fp = String(repeating: "ab", count: 32)
    static let link = "usagedeck://pair?v=2&name=laptop&addrs=laptop.local&port=47292&fp=\(fp)&code=abcdefghijklmnopqrstuv"

    func url(_ text: String) throws -> URL {
        try #require(URL(string: text))
    }

    @Test(arguments: ["usagedeck://open", "usagedeck://", "usagedeck://settings?x=1", "https://example.test/pair", "other://pair?v=2"])
    func aLinkThatIsNotAPairingLinkChangesNothing(text: String) throws {
        var flow = PairingFlow()
        #expect(try !flow.open(url(text)))
        #expect(flow == PairingFlow())
    }

    @Test func openingTheAppFromAWidgetLeavesARepairInProgressAlone() throws {
        var flow = PairingFlow()
        flow.begin(replacing: "d1")
        let before = flow
        #expect(try !flow.open(url("usagedeck://open")))
        #expect(flow == before)
        #expect(flow.showing && flow.replacing == "d1" && flow.error == nil)
    }

    @Test func aPairingLinkFromOutsideOffersItsInvite() throws {
        var flow = PairingFlow()
        #expect(try flow.open(url(Self.link)))
        #expect(flow.pending?.invite.name == "laptop")
        #expect(flow.pending?.replacing == nil)
        #expect(!flow.showing, "the confirmation shows over whatever is on screen")
    }

    @Test func aLinkFromOutsideNeverInheritsTheRepair() throws {
        var flow = PairingFlow()
        flow.begin(replacing: "d1")
        #expect(try flow.open(url(Self.link)))
        #expect(flow.pending?.replacing == nil, "only a scan or paste inside the sheet may replace a device")
        #expect(flow.replacing == "d1", "the sheet itself is still re-pairing d1")
    }

    @Test func aScanOrPasteInsideTheRepairSheetReplacesTheDevice() {
        var flow = PairingFlow()
        flow.begin(replacing: "d1")
        flow.offer(PairingInput.classify(Self.link), origin: .inApp)
        #expect(flow.pending?.replacing == "d1")
    }

    @Test func aScanInAPlainPairingSheetReplacesNothing() {
        var flow = PairingFlow()
        flow.begin(replacing: nil)
        flow.offer(PairingInput.classify(Self.link), origin: .inApp)
        #expect(flow.pending?.replacing == nil)
    }

    @Test func aMalformedPairingLinkOpensTheSheetWithItsError() throws {
        var flow = PairingFlow()
        #expect(try flow.open(url("usagedeck://pair?v=2&name=x")))
        #expect(flow.showing)
        #expect(flow.pending == nil)
        #expect(flow.error?.plain == "The pairing link has no addresses.")
    }

    @Test func aMalformedLinkFromOutsideDoesNotCancelARepair() throws {
        var flow = PairingFlow()
        flow.begin(replacing: "d1")
        #expect(try flow.open(url("usagedeck://pair?v=2&name=x")))
        #expect(flow.replacing == "d1")
    }

    @Test func cancelAndSuccessBothClearEverything() {
        var flow = PairingFlow()
        flow.begin(replacing: "d1")
        flow.offer(PairingInput.classify(Self.link), origin: .inApp)
        flow.cancel()
        #expect(flow == PairingFlow())

        flow.begin(replacing: "d1")
        flow.failed(.untrusted("nope"))
        #expect(flow.showing && flow.error?.plain == "nope")
        flow.paired()
        #expect(flow == PairingFlow())
    }

    @Test func beginningClearsAnOldError() {
        var flow = PairingFlow()
        flow.failed(.untrusted("nope"))
        flow.begin(replacing: nil)
        #expect(flow.error == nil)
    }
}

/// What the "Pair <name>?" confirmation says, and when it must warn about the certificate.
struct PairingPromptTests {
    let studio = DeviceRecord(
        id: "d1",
        name: "studio.local",
        addrs: ["192.168.1.20", "studio.local"],
        port: 47292,
        fingerprint: String(repeating: "a", count: 64)
    )

    func invite(name: String = "studio", addrs: [String] = ["studio.local"], fingerprint: String) -> PairingInvite {
        PairingInvite(name: name, addrs: addrs, port: 47292, fingerprint: fingerprint, code: "c")
    }

    @Test func aNewPairingJustAsks() {
        let prompt = PairingPrompt.make(invite: invite(fingerprint: String(repeating: "b", count: 64)), replacing: nil)
        #expect(prompt.title == "Pair studio?")
        #expect(prompt.confirm == "Pair")
        #expect(!prompt.certificateDiffers)
        #expect(!prompt.offersPairAsNew)
        #expect(prompt.message.contains("studio.local"))
    }

    @Test func aRepairWithTheSameCertificateNeedsNoWarning() {
        let same = invite(name: "renamed", addrs: ["192.0.2.9"], fingerprint: studio.fingerprint)
        let prompt = PairingPrompt.make(invite: same, replacing: studio)
        #expect(!prompt.certificateDiffers)
        #expect(!prompt.message.lowercased().contains("differ"))
        #expect(prompt.title == "Re-pair studio?")
        #expect(!prompt.offersPairAsNew)
    }

    @Test func aRepairWithAnotherCertificateSaysSoEvenWhenNameAndAddressMatch() {
        let other = String(repeating: "b", count: 64)
        let prompt = PairingPrompt.make(invite: invite(name: "studio", addrs: ["192.168.1.20"], fingerprint: other), replacing: studio)
        #expect(prompt.certificateDiffers)
        #expect(prompt.message.contains("certificate in this code differs from the one studio was paired with"))
        #expect(prompt.title == "Replace studio's certificate?")
        #expect(prompt.confirm == "Replace")
        #expect(prompt.offersPairAsNew)
    }

    @Test func aRepairWithAnotherDeviceSaysBothThings() {
        let other = String(repeating: "b", count: 64)
        let prompt = PairingPrompt.make(invite: invite(name: "laptop", addrs: ["laptop.local"], fingerprint: other), replacing: studio)
        #expect(prompt.certificateDiffers)
        #expect(prompt.title == "Replace studio with laptop?")
        #expect(prompt.message.contains("This code is from laptop, not studio"))
        #expect(prompt.message.contains("certificate in this code differs from the one studio was paired with"))
        #expect(prompt.offersPairAsNew)
    }

    @Test func theWarningNeverDependsOnWhatTheInviteCallsItself() {
        let other = String(repeating: "b", count: 64)
        for name in ["studio", "studio.local", "STUDIO", "laptop"] {
            for addrs in [["192.168.1.20"], ["studio.local"], ["198.51.100.7"]] {
                let prompt = PairingPrompt.make(invite: invite(name: name, addrs: addrs, fingerprint: other), replacing: studio)
                #expect(prompt.certificateDiffers, "\(name) \(addrs)")
            }
        }
    }
}
