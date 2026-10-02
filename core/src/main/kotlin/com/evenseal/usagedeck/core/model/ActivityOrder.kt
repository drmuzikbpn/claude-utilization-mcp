package com.evenseal.usagedeck.core.model

import kotlin.math.floor
import kotlin.math.log10

/**
 * The home screens' order: whatever is burning fastest right now goes on top. Projects rank by
 * their own rate and their sessions by theirs; the landscape list ranks every session on its own.
 *
 * Rates are compared by band (eight per decade, about 33 % apart) rather than exactly, so two rows
 * burning at nearly the same pace keep their places instead of swapping on every tick; ties keep
 * the incoming order. The same rule as the iPhone app's `ActivityOrder`.
 */
object ActivityOrder {
    /** One live session and the project it belongs to. */
    data class Row(val project: ProjectView, val session: Session)

    /** Live projects (those with sessions), fastest first, each with its sessions fastest first. */
    fun projects(
        projects: List<ProjectView>,
        projectRate: (ProjectView) -> Double,
        sessionRate: (ProjectView, Session) -> Double
    ): List<ProjectView> = projects
        .filter { it.sessions.isNotEmpty() }
        .map { project ->
            project.copy(
                sessions = project.sessions.sortedByDescending { band(sessionRate(project, it)) }
            )
        }
        .sortedByDescending { band(projectRate(it)) }

    /** Every live session as one list, fastest first. */
    fun sessions(projects: List<ProjectView>, sessionRate: (ProjectView, Session) -> Double): List<Row> = projects
        .flatMap { project -> project.sessions.map { Row(project, it) } }
        .sortedByDescending { band(sessionRate(it.project, it.session)) }

    /** Eight bands per decade of tokens/min; anything under one token a minute is idle. */
    internal fun band(rate: Double): Int =
        if (rate < 1.0) Int.MIN_VALUE else floor(log10(rate) * BANDS_PER_DECADE).toInt()

    private const val BANDS_PER_DECADE = 8
}
