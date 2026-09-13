package com.evenseal.usagedeck.ui.theme

import androidx.compose.ui.graphics.Color
import com.evenseal.usagedeck.core.model.LimitStatus

/** The single dark palette from spec §11.6. There is no light theme; this is a dock LCD. */
object DeckColors {
    val bg = Color(0xFF0E1013)
    val surface = Color(0xFF161A20)
    val surface2 = Color(0xFF1E242C)
    val line = Color(0xFF262D37)
    val fg = Color(0xFFE8EBEF)
    val muted = Color(0xFF8B95A3)
    val dim = Color(0xFF5C6674)
    val ok = Color(0xFF3DBE8B)
    val warn = Color(0xFFF0B429)
    val crit = Color(0xFFE5484D)
    val frozen = Color(0xFF5AB4C4)
    val accent = Color(0xFF8C9BFF)

    fun of(status: LimitStatus): Color = when (status) {
        LimitStatus.OK -> ok
        LimitStatus.WARN -> warn
        LimitStatus.CRITICAL -> crit
    }
}
