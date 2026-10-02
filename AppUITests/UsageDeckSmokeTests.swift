import XCTest

/// Walks every iPhone screen in demo mode (`-UsageDeckDemo`, Debug only: two made-up devices,
/// no daemon) and attaches a screenshot of each.
final class UsageDeckSmokeTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-UsageDeckDemo"]
        app.launch()
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor
    func testLedgerProjectDeviceSettingsAndPairing() {
        XCTAssertTrue(app.staticTexts["Alan"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Pause all"].exists)
        snap("ledger")

        app.staticTexts["Alan"].tap()
        app.buttons["Expand claude-utilization-mcp"].tap()
        XCTAssertTrue(app.staticTexts["usage-ios phone"].waitForExistence(timeout: 5))
        snap("ledger-expanded")

        app.buttons["Open claude-utilization-mcp"].tap()
        XCTAssertTrue(app.staticTexts["share of today"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Pause project"].exists)
        snap("project")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["Projects"].tap()
        XCTAssertTrue(app.staticTexts["podcast-site"].waitForExistence(timeout: 5))
        snap("projects")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Warn at"].waitForExistence(timeout: 5))
        snap("settings")
        app.buttons["studio"].tap()
        XCTAssertTrue(app.staticTexts["Setup"].waitForExistence(timeout: 5))
        snap("device")
        app.buttons["Re-pair"].tap()
        XCTAssertTrue(app.staticTexts["Or paste the pairing link"].waitForExistence(timeout: 5))
        let field = app.textFields.firstMatch
        field.tap()
        field.typeText(#"{"v":1,"name":"studio","addr":"100.64.0.7","port":47291,"token":"abc"}"#)
        app.buttons["Pair"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Android pairing code'")).firstMatch
            .waitForExistence(timeout: 5))
        snap("pairing")
    }

    /// `-UsageDeckDemoConnecting`: the overlay a fresh pairing shows, landing on a populated
    /// device screen once studio's first load is in.
    @MainActor
    func testConnectingOverlayLandsOnAPopulatedDevice() {
        relaunch(["-UsageDeckDemoConnecting"])
        XCTAssertTrue(element(labelled: "BEGINSWITH 'Connecting to studio'").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Skip"].exists)
        snap("connecting")
        XCTAssertTrue(element(labelled: "== 'Connected to studio'").waitForExistence(timeout: 10))
        snap("connected")
        // The setup checklist came from the first load, not the "Checking…" placeholder.
        XCTAssertTrue(element(labelled: "== 'Reachable: OK'").waitForExistence(timeout: 10))
        XCTAssertTrue(element(labelled: "== 'Usage limits: OK'").exists)
        XCTAssertTrue(app.staticTexts["0.1.140+demo"].exists)
        XCTAssertFalse(element(labelled: "BEGINSWITH 'Connect'").exists)
        snap("connected-device")
    }

    /// `-UsageDeckDemoConnectingHold` never lands by itself, so only Skip can close it.
    @MainActor
    func testConnectingOverlaySkipOpensTheDevice() {
        relaunch(["-UsageDeckDemoConnectingHold"])
        XCTAssertTrue(app.buttons["Skip"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Setup"].exists)
        app.buttons["Skip"].tap()
        XCTAssertTrue(app.staticTexts["Setup"].waitForExistence(timeout: 5))
        XCTAssertFalse(element(labelled: "BEGINSWITH 'Connecting to studio'").exists)
    }

    /// `-UsageDeckDemoNeedsRepair`: studio's token was changed. Home says so and Re-pair opens
    /// pairing in re-pair mode for that device.
    @MainActor
    func testLostPairingOffersARepair() {
        relaunch(["-UsageDeckDemoNeedsRepair"])
        XCTAssertTrue(app.staticTexts["studio no longer accepts this iPhone"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Its access token was changed."].exists)
        snap("needs-repair")
        app.buttons["Re-pair studio"].tap()
        XCTAssertTrue(app.navigationBars["Re-pair"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Or paste the pairing link"].exists)
        snap("re-pair")
    }

    @MainActor
    func testWideDockInLandscape() {
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'team today'")).firstMatch
            .waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Pause all"].exists)
        // The dock must actually fill the landscape window: the rail's Pause all on the left, the
        // sessions pane reaching past the middle.
        let window = app.windows.firstMatch.frame
        let caption = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sessions'")).firstMatch
        let rateHeader = app.staticTexts["tok/min · 30m"]
        XCTAssertGreaterThan(window.width, window.height, "window is landscape")
        XCTAssertLessThan(app.buttons["Pause all"].frame.midX, window.midX, "rail sits left")
        XCTAssertGreaterThan(caption.frame.minX, app.buttons["Pause all"].frame.maxX, "sessions pane is right of the rail")
        XCTAssertGreaterThan(rateHeader.frame.maxX, window.width * 0.75, "sessions pane reaches the right edge")
        snap("wide-dock")
    }

    @MainActor
    private func relaunch(_ extra: [String]) {
        app.terminate()
        app.launchArguments = ["-UsageDeckDemo"] + extra
        app.launch()
    }

    @MainActor
    private func element(labelled predicate: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label \(predicate)")).firstMatch
    }

    @MainActor
    private func snap(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
