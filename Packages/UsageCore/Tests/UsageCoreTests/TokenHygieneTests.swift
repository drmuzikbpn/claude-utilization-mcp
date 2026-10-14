// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation
import Testing
@testable import UsageCore

/// Tokens outlive the records that own them (the Keychain survives an uninstall): the ones
/// nothing points at are removed.
struct TokenHygieneTests {
    @Test func removesTokensNoPairedDeviceOwns() throws {
        let store = InMemoryTokenStore()
        try store.setToken("a", for: "d1")
        try store.setToken("b", for: "left-by-an-earlier-install")
        try store.setToken("c", for: "removed-device")
        let removed = TokenHygiene.sweep(store, keeping: [record(id: "d1", addrs: ["a.test"])])
        #expect(removed == 2)
        #expect(store.deviceIds() == ["d1"])
        #expect(store.token(for: "d1") == "a")
        #expect(store.token(for: "removed-device") == nil)
    }

    @Test func aFreshInstallWithNothingPairedClearsEverything() throws {
        let store = InMemoryTokenStore()
        try store.setToken("a", for: "d1")
        #expect(TokenHygiene.sweep(store, keeping: []) == 1)
        #expect(store.deviceIds().isEmpty)
    }

    @Test func nothingToDoIsNothingDone() throws {
        let store = InMemoryTokenStore()
        try store.setToken("a", for: "d1")
        #expect(TokenHygiene.sweep(store, keeping: [record(id: "d1", addrs: ["a.test"])]) == 0)
        #expect(TokenHygiene.sweep(InMemoryTokenStore(), keeping: []) == 0)
    }
}

struct AddressCapTests {
    @Test func aDeviceCannotGrowItsAddressListWithoutBound() {
        let reported = (1 ... 100).map { "h\($0).example.test" }
        let merged = AddressMerge.merge(paired: ["studio.local"], reported: reported)
        #expect(merged.count == AddressMerge.limit)
        #expect(merged.first == "studio.local", "what was paired is never pushed out")
        #expect(merged[1] == "h1.example.test")
    }
}
