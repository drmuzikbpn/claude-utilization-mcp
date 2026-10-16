// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import XCTest

/// The landscape set for the App Store and the README: demo data (`-UsageDeckDemo`, Debug only),
/// whole-screen captures. Landscape is how the deck is meant to sit on a desk stand.
final class StoreScreenshotTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-UsageDeckDemo"]
        app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor
    func testLandscapeScreens() {
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'team today'")).firstMatch
            .waitForExistence(timeout: 10))
        // Let the rings and sparklines finish their entrance.
        sleep(2)
        snap("landscape-1-dock")

        app.buttons["Projects"].tap()
        XCTAssertTrue(app.staticTexts["photo-archive"].waitForExistence(timeout: 5))
        sleep(1)
        snap("landscape-2-projects")

        app.staticTexts["garden-planner"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["share of today"].waitForExistence(timeout: 5))
        sleep(2)
        snap("landscape-3-project")
    }

    @MainActor
    private func snap(_ name: String) {
        // app.screenshot() comes back as a portrait frame cut square in landscape; the screen's is whole.
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
