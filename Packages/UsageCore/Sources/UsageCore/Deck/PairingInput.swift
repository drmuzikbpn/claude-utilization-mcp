// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// What the pairing screen makes of a scanned, opened or pasted string.
public enum PairingInput: Sendable, Equatable {
    case invite(PairingInvite)
    /// Shown under the paste field; only its literal parts may be styled.
    case rejected(DeckText)

    public static let legacyText = DeckText.literal(
        "This old pairing code carries an access token and is not accepted. Run `claude-usage pair` on the device instead."
    )
    public static var legacyMessage: String {
        legacyText.plain
    }

    /// The v1 JSON that older daemons printed (`claude-usage configure pairing`) holds a live
    /// bearer for plain HTTP. Daemons no longer issue it and this app pairs only through the v2
    /// one-time-code link, so a paste is explained, never used (its token is never kept or echoed).
    public static func classify(_ raw: String) -> PairingInput {
        switch PairingLink.parse(raw) {
        case let .success(.invite(invite)): .invite(invite)
        case .success(.legacy): .rejected(legacyText)
        case let .failure(error): .rejected(error.text)
        }
    }
}
