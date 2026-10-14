// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// User-facing copy that knows which of its parts may be styled.
///
/// SwiftUI draws a `LocalizedStringKey` as Markdown, so text that came from a pairing link, an
/// invite or a device could otherwise plant a tappable link or restyle a warning. The rule lives
/// here: only a segment written in this app's source (`literal`, which takes nothing but a
/// compile-time string) may be Markdown; everything else is drawn character for character.
public struct DeckText: Sendable, Equatable {
    public struct Segment: Sendable, Equatable {
        public let text: String
        /// True only for a literal from this app's source.
        public let isMarkdown: Bool
    }

    public private(set) var segments: [Segment]

    /// Copy written in this app's source. `StaticString` keeps anything computed at run time out.
    public static func literal(_ text: StaticString) -> DeckText {
        DeckText(segments: [Segment(text: "\(text)", isMarkdown: true)])
    }

    /// Anything a link, an invite or a device had a hand in.
    public static func untrusted(_ text: String) -> DeckText {
        DeckText(segments: [Segment(text: text, isMarkdown: false)])
    }

    public static func + (lhs: DeckText, rhs: DeckText) -> DeckText {
        DeckText(segments: lhs.segments + rhs.segments)
    }

    /// True when every part was written in this app's source.
    public var isTrusted: Bool {
        segments.allSatisfy(\.isMarkdown)
    }

    /// The characters as written, for logs, accessibility and tests.
    public var plain: String {
        segments.map(\.text).joined()
    }
}

/// A device's name as this app keeps and shows it: no control, format or private-use characters
/// (a newline would forge a log line, a direction override would disguise a name) and at most
/// `limit` characters.
public enum DeviceName {
    public static let limit = 64

    public static func clean(_ raw: String) -> String {
        let kept = raw.unicodeScalars.filter { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator, .privateUse, .surrogate, .unassigned: false
            default: true
            }
        }
        let text = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespacesAndNewlines)
        return String(text.prefix(limit))
    }
}

public extension DaemonError {
    /// `userMessage` for the screen. A device wrote (or could have caused) it, so never Markdown.
    var displayText: DeckText {
        .untrusted(userMessage)
    }
}
