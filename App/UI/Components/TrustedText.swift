// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import SwiftUI
import UsageCore

extension Text {
    /// Draws `DeckText` by its own rule: a literal from this app's source as Markdown, every
    /// other part character for character. The one place a non-literal becomes a
    /// `LocalizedStringKey`, and only for segments `DeckText.literal` made.
    init(_ deck: DeckText) {
        self = deck.segments.reduce(Text(verbatim: "")) { joined, segment in
            // swiftlint:disable:next no_markdown_from_variable
            let part = segment.isMarkdown ? Text(LocalizedStringKey(segment.text)) : Text(verbatim: segment.text)
            // swiftlint:disable:next no_interpolated_markdown
            return Text("\(joined)\(part)")
        }
    }
}
