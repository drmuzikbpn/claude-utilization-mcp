package com.evenseal.usagedeck.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.R

/**
 * Three families, one job each (spec §11.6): condensed numerals for the big figures, a humanist
 * sans for prose and a mono for data.
 */
object DeckType {
    val numeral: FontFamily = FontFamily(
        Font(R.font.barlow_condensed_500, FontWeight.Medium),
        Font(R.font.barlow_condensed_600, FontWeight.SemiBold),
        Font(R.font.barlow_condensed_700, FontWeight.Bold)
    )

    val text: FontFamily = FontFamily(
        Font(R.font.ibm_plex_sans_400, FontWeight.Normal),
        Font(R.font.ibm_plex_sans_500, FontWeight.Medium),
        Font(R.font.ibm_plex_sans_600, FontWeight.SemiBold)
    )

    val mono: FontFamily = FontFamily(
        Font(R.font.ibm_plex_mono_400, FontWeight.Normal),
        Font(R.font.ibm_plex_mono_500, FontWeight.Medium)
    )

    /** Tabular numerals everywhere, so figures do not jitter as they tick. */
    const val TABULAR = "tnum"
}

private val body = TextStyle(
    fontFamily = DeckType.text,
    fontFeatureSettings = DeckType.TABULAR
)

internal val deckTypography = Typography(
    displayLarge = body.copy(fontFamily = DeckType.numeral, fontWeight = FontWeight.SemiBold, fontSize = 64.sp),
    displayMedium = body.copy(fontFamily = DeckType.numeral, fontWeight = FontWeight.SemiBold, fontSize = 44.sp),
    displaySmall = body.copy(fontFamily = DeckType.numeral, fontWeight = FontWeight.Medium, fontSize = 30.sp),
    headlineMedium = body.copy(fontFamily = DeckType.numeral, fontWeight = FontWeight.SemiBold, fontSize = 24.sp),
    titleMedium = body.copy(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    titleSmall = body.copy(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    bodyMedium = body.copy(fontSize = 14.sp),
    bodySmall = body.copy(fontSize = 12.sp),
    labelMedium = body.copy(fontFamily = DeckType.mono, fontSize = 12.sp),
    labelSmall = body.copy(fontFamily = DeckType.mono, fontSize = 11.sp)
)
