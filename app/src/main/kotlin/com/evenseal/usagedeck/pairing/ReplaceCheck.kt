package com.evenseal.usagedeck.pairing

/**
 * A Re-pair card names the row it means to replace; a QR from another machine scanned there by
 * mistake would silently overwrite it. [needsConfirm] is true when the scanned name matches none
 * of the row's names (stored or reported by its daemon), comparing whole names and then the
 * first label, so `studio` and `studio.tail0fake.ts.net` count as the same machine.
 */
object ReplaceCheck {
    fun needsConfirm(oldNames: List<String>, newName: String): Boolean {
        if (oldNames.isEmpty()) return false
        return oldNames.none { old -> old.equals(newName, ignoreCase = true) || short(old) == short(newName) }
    }

    private fun short(name: String) = name.trim().substringBefore('.').lowercase()
}
