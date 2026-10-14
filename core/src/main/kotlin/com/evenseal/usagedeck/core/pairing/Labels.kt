// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.pairing

/**
 * A machine name as it may be shown and stored. Names arrive from a QR, a pairing reply and the
 * event stream — all outside the deck's control — so control characters (which could forge log
 * lines) and invisible formatting characters (direction overrides that could make one name read
 * as another in a confirmation) are dropped, and the length is capped.
 */
object Labels {
    const val MAX_NAME_LENGTH = 64

    fun machineName(raw: String): String = raw
        .filterNot { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() }
        .trim()
        .take(MAX_NAME_LENGTH)
        .trim()
}
