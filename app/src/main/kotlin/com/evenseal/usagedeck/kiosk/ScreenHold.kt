package com.evenseal.usagedeck.kiosk

/**
 * Whether the deck's window holds the screen at full brightness (`FLAG_KEEP_SCREEN_ON`).
 *
 * `STAY_ON_WHILE_PLUGGED_IN` only stops the screen turning *off*: Android still drops it to the
 * dim level once the inactivity timeout passes. A docked deck is meant to be read from across
 * the room, so on power the window always holds the screen (spec §5 "always on"); on battery it
 * is the owner's "Keep screen on" choice. Adaptive brightness keeps working either way — the hold
 * pins the *policy* at bright, not the nit level.
 */
object ScreenHold {
    fun shouldHold(mode: DeckMode, keepScreenOn: Boolean): Boolean = mode == DeckMode.DOCK || keepScreenOn
}
