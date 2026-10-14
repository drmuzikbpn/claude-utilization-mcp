// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// What the pairing screen makes of a scanned, opened or pasted string.
public enum PairingInput: Sendable, Equatable {
    case invite(PairingInvite)
    /// Shown under the paste field; only its literal parts may be styled.
    case rejected(DeckText)

    public static let androidText = DeckText.literal("This is an Android pairing code — run `claude-usage pair` on the device instead")
    public static var androidMessage: String {
        androidText.plain
    }

    /// The v1 JSON from `claude-usage configure pairing` is the Android deck's plain-HTTP bearer
    /// pairing; the iPhone pairs only through the v2 one-time-code link, so it is explained,
    /// never used (and its token is never kept or echoed).
    public static func classify(_ raw: String) -> PairingInput {
        switch PairingLink.parse(raw) {
        case let .success(.invite(invite)): .invite(invite)
        case .success(.legacy): .rejected(androidText)
        case let .failure(error): .rejected(error.text)
        }
    }
}
