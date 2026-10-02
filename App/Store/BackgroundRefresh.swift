import BackgroundTasks
import Foundation

/// Best-effort background freshness (D4): a `BGAppRefreshTask` re-reads every device over REST,
/// raises alerts, rewrites the widgets' snapshot and pushes to the watch. iOS decides when (and
/// whether) it runs; "earliest in 15 minutes" is a request, not a schedule.
enum BackgroundRefresh {
    static let identifier = "com.evenseal.usagedeck.refresh"
    static let interval: TimeInterval = 15 * 60

    /// Must run before the app finishes launching.
    static func register(_ work: @escaping @Sendable () async -> Void) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            let box = TaskBox(task)
            schedule()
            let run = Task {
                await work()
            }
            box.task.expirationHandler = { run.cancel() }
            Task {
                await run.value
                box.task.setTaskCompleted(success: !run.isCancelled)
            }
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
        try? BGTaskScheduler.shared.submit(request)
    }
}

/// `BGTask` is not `Sendable`; the system allows setting its expiration handler and completing
/// it from any thread.
private final class TaskBox: @unchecked Sendable {
    let task: BGTask

    init(_ task: BGTask) {
        self.task = task
    }
}
