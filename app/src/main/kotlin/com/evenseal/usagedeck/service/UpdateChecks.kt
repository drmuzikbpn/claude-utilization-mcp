package com.evenseal.usagedeck.service

import kotlinx.coroutines.flow.StateFlow

/**
 * What the Settings screen needs from the self-updater, without depending on how it works.
 *
 * The graph holds this as a nullable collaborator because it genuinely is absent until
 * [DeckService] starts: on a phone whose service has been killed the deck still renders, and
 * Settings says so rather than pretending a check is running.
 */
interface UpdateChecks {
    /** A short, user-facing description of where the updater has got to. */
    val label: StateFlow<String>

    suspend fun checkNow()
}
