// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import XCTest

/// "Try the demo" on the empty home screen: how App Review, and anyone without the daemon, sees
/// the app. Runs with no launch arguments, as an App Store build would, on a simulator with
/// nothing paired.
final class TryTheDemoTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor
    func testTheDemoShowsMadeUpDevicesAndLeavesCleanly() throws {
        guard app.staticTexts["No paired devices"].waitForExistence(timeout: 10) else {
            throw XCTSkip("this simulator has a paired device")
        }
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(app.staticTexts["Adam"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Demo · made-up devices and sessions"].exists)

        app.buttons["Leave"].tap()
        XCTAssertTrue(app.staticTexts["No paired devices"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Adam"].exists)
    }

    @MainActor
    func testPairingFromTheDemoLeavesIt() throws {
        guard app.staticTexts["No paired devices"].waitForExistence(timeout: 10) else {
            throw XCTSkip("this simulator has a paired device")
        }
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(app.staticTexts["Adam"].waitForExistence(timeout: 5))

        app.buttons["Settings"].tap()
        XCTAssertTrue(app.buttons["Leave the demo"].waitForExistence(timeout: 5))
        app.buttons["Pair a device"].tap()
        XCTAssertTrue(app.staticTexts["Or paste the pairing link"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.staticTexts["No paired devices"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testTheDemoDoesNotSurviveARelaunch() throws {
        guard app.staticTexts["No paired devices"].waitForExistence(timeout: 10) else {
            throw XCTSkip("this simulator has a paired device")
        }
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(app.staticTexts["Adam"].waitForExistence(timeout: 5))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["No paired devices"].waitForExistence(timeout: 10))
    }
}
