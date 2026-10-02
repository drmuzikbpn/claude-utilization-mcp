import Foundation
import UsageCore
import UserNotifications

/// Delivers alerts as local notifications. iOS mirrors them to the paired watch whenever the
/// iPhone is locked, which is how the watch hears about them (D8). During quiet hours they still
/// arrive, silently and without lighting the screen.
@MainActor
final class AlertNotifier: NSObject {
    private let center = UNUserNotificationCenter.current()

    /// Becomes the notification centre's delegate so a banner still shows while the app is open.
    func install() {
        center.delegate = self
    }

    /// Asked at the first pairing, when there is finally something to be alerted about.
    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func post(_ alert: Alert, quiet: Bool) {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.threadIdentifier = alert.kind.rawValue
        if quiet {
            content.interruptionLevel = .passive
        } else {
            content.sound = .default
            content.interruptionLevel = .active
        }
        // Same key, same window: a re-delivery replaces the earlier banner instead of stacking.
        let id = alert.window.map { "\(alert.key)|\($0)" } ?? alert.key
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { _ in }
    }
}

extension AlertNotifier: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let passive = notification.request.content.interruptionLevel == .passive
        completionHandler(passive ? [.list] : [.banner, .list, .sound])
    }
}
