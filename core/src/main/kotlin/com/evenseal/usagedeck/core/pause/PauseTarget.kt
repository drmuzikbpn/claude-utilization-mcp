package com.evenseal.usagedeck.core.pause

/**
 * What a pause gesture acts on. Session and project scopes address exactly one machine;
 * only [All] fans out.
 */
sealed interface PauseTarget {
    data class Session(val machineId: String, val sessionId: String) : PauseTarget

    data class Project(val machineId: String, val projectKey: String) : PauseTarget

    object All : PauseTarget

    /** The daemon's scope grammar (daemon spec §18.1). */
    fun scope(): String = when (this) {
        is Session -> "session:$sessionId"
        is Project -> "project:$projectKey"
        All -> "all"
    }
}
