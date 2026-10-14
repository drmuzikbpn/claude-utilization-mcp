// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// The pairing sheet's state: whether it shows, which device a "Re-pair" is replacing, the invite
/// waiting for its confirmation and the last error.
///
/// It also draws the line between a pairing string that came from inside the sheet (a scan or a
/// paste, which the user aimed at the device they are re-pairing) and one that arrived from
/// outside the app (a link another app or a web page opened). Only the first may replace a device.
public struct PairingFlow: Sendable, Equatable {
    public enum Origin: Sendable, Equatable {
        /// Scanned or pasted in the pairing sheet.
        case inApp
        /// A `usagedeck://` link the system handed over.
        case external
    }

    /// An invite waiting for "Pair <name>?", with the device it would replace decided when it
    /// arrived rather than when it is confirmed.
    public struct Offer: Sendable, Equatable {
        public var invite: PairingInvite
        public var replacing: String?

        public init(invite: PairingInvite, replacing: String?) {
            self.invite = invite
            self.replacing = replacing
        }
    }

    public var showing = false
    /// Set by "Re-pair" on a device: an invite scanned or pasted in the sheet replaces its token.
    public private(set) var replacing: String?
    public var pending: Offer?
    public private(set) var error: DeckText?

    public init() {}

    /// Opens the sheet; `id` is the device a "Re-pair" is for.
    public mutating func begin(replacing id: String?) {
        replacing = id
        error = nil
        showing = true
    }

    public mutating func cancel() {
        self = PairingFlow()
    }

    /// A URL the system handed the app. Anything but `usagedeck://pair…` (a widget's
    /// `usagedeck://open`, say) only brought the app forward: nothing changes and it returns false.
    @discardableResult
    public mutating func open(_ url: URL) -> Bool {
        guard PairingLink.isPairingURL(url) else { return false }
        offer(PairingInput.classify(url.absoluteString), origin: .external)
        return true
    }

    public mutating func offer(_ input: PairingInput, origin: Origin) {
        switch input {
        case let .invite(invite):
            error = nil
            pending = Offer(invite: invite, replacing: origin == .inApp ? replacing : nil)
        case let .rejected(text):
            error = text
            showing = true
        }
    }

    /// The redeem failed: back to the sheet with the reason.
    public mutating func failed(_ text: DeckText) {
        error = text
        showing = true
    }

    public mutating func paired() {
        self = PairingFlow()
    }
}

/// The one confirmation every pairing goes through, as plain strings (drawn verbatim: the names
/// and addresses in them come from the invite).
public struct PairingPrompt: Sendable, Equatable {
    public var title: String
    public var message: String
    /// The confirming button: "Pair", "Re-pair" or "Replace".
    public var confirm: String
    /// True when the invite's certificate is not the one the device being re-paired was paired
    /// with; the message then says so, whatever the invite calls itself.
    public var certificateDiffers: Bool
    /// Offer "Pair as new" next to the confirming button.
    public var offersPairAsNew: Bool

    /// `replacing` is the record a "Re-pair" is about to overwrite, nil for a new pairing.
    public static func make(invite: PairingInvite, replacing: DeviceRecord?) -> PairingPrompt {
        let reach = "Usage Deck will connect to \(invite.addrs.joined(separator: ", ")) over HTTPS pinned to this device's certificate."
        guard let replacing else {
            return PairingPrompt(
                title: "Pair \(invite.name)?",
                message: reach,
                confirm: "Pair",
                certificateDiffers: false,
                offersPairAsNew: false
            )
        }
        let old = Format.hostShort(replacing.name)
        guard RepairMatch.certificateDiffers(replacing, invite) else {
            return PairingPrompt(
                title: "Re-pair \(old)?",
                message: reach,
                confirm: "Re-pair",
                certificateDiffers: false,
                offersPairAsNew: false
            )
        }
        let warning = "The certificate in this code differs from the one \(old) was paired with. That is expected only if "
            + "\(old)'s certificate was regenerated; otherwise this code is from another device. "
            + "Replace makes Usage Deck trust the new certificate in \(old)'s place"
        if RepairMatch.sameDevice(replacing, invite) {
            return PairingPrompt(
                title: "Replace \(old)'s certificate?",
                message: "\(warning); Pair as new keeps \(old) as it is and adds this code as another device.",
                confirm: "Replace",
                certificateDiffers: true,
                offersPairAsNew: true
            )
        }
        return PairingPrompt(
            title: "Replace \(old) with \(invite.name)?",
            message: "This code is from \(invite.name), not \(old). \(warning) and keeps \(old)'s settings; "
                + "Pair as new adds \(invite.name) alongside it.",
            confirm: "Replace",
            certificateDiffers: true,
            offersPairAsNew: true
        )
    }
}
