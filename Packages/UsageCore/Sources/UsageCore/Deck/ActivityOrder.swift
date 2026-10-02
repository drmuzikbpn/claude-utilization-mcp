import Foundation

/// The home screens' order: whatever is burning fastest right now goes on top. Projects rank by
/// their own rate and their sessions by theirs; the landscape list ranks every session on its own.
///
/// Rates are compared by band (eight per decade, about 33 % apart) rather than exactly, so two
/// rows burning at nearly the same pace keep their places instead of swapping on every tick; ties
/// keep the incoming order.
public enum ActivityOrder {
    /// One live session and the project it belongs to.
    public struct Row: Sendable, Equatable {
        public var project: ProjectView
        public var session: Session
    }

    /// Live projects (those with sessions), fastest first, each with its sessions fastest first.
    public static func projects(
        _ projects: [ProjectView],
        projectRate: (ProjectView) -> Double,
        sessionRate: (ProjectView, Session) -> Double
    ) -> [ProjectView] {
        projects
            .filter { !$0.sessions.isEmpty }
            .map { project in
                var project = project
                project.sessions = project.sessions.stableSorted { band(sessionRate(project, $0)) > band(sessionRate(project, $1)) }
                return project
            }
            .stableSorted { band(projectRate($0)) > band(projectRate($1)) }
    }

    /// Every live session as one list, fastest first.
    public static func sessions(_ projects: [ProjectView], sessionRate: (ProjectView, Session) -> Double) -> [Row] {
        projects
            .flatMap { project in project.sessions.map { Row(project: project, session: $0) } }
            .stableSorted { band(sessionRate($0.project, $0.session)) > band(sessionRate($1.project, $1.session)) }
    }

    /// Eight bands per decade of tokens/min; anything under one token a minute is idle.
    static func band(_ rate: Double) -> Int {
        rate < 1 ? Int.min : Int((log10(rate) * 8).rounded(.down))
    }
}
