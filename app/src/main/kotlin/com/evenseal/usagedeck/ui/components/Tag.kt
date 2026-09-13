package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * The small rounded label from the mockups (`.tag`): mono, 10 sp, 5 dp corners. A neutral tag sits
 * on `surface2`; a tinted one takes its colour at 15 % for the ground and full for the text.
 */
@Composable
fun Tag(text: String, color: Color? = null, modifier: Modifier = Modifier) {
    Text(
        modifier = modifier
            .clip(RoundedCornerShape(5.dp))
            .background(color?.copy(alpha = 0.15f) ?: DeckColors.surface2)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        text = text,
        color = color ?: DeckColors.muted,
        fontFamily = DeckType.mono,
        fontSize = 10.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
}
