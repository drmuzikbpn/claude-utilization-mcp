package com.evenseal.usagedeck.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.zIndex
import com.evenseal.usagedeck.ui.theme.DeckColors
import kotlinx.coroutines.launch

/**
 * Rows leapfrog as projects re-rank by live burn. Rather than the stock slide alone, the row that
 * climbs lifts over its neighbours — drawn on top, a touch larger, on its own opaque surface — and
 * every row that moved blinks once so the eye catches the change. Rows that fall only slide.
 *
 * [position] is the row's index in the list; the modifier animates whenever it changes. Pair it with
 * `LazyItemScope.animateItem(placementSpec = REORDER_SLIDE)` for the slide itself.
 */
@Composable
fun Modifier.liftOnReorder(position: Int): Modifier {
    val lift = remember { Animatable(0f) }
    val blink = remember { Animatable(1f) }
    var last by remember { mutableIntStateOf(position) }
    LaunchedEffect(position) {
        val climbed = position < last
        val moved = position != last
        last = position
        if (!moved) return@LaunchedEffect
        launch {
            blink.snapTo(1f)
            blink.animateTo(BLINK_FLOOR, tween(BLINK_OUT_MS))
            blink.animateTo(1f, tween(BLINK_IN_MS))
        }
        if (climbed) {
            lift.snapTo(0f)
            lift.animateTo(1f, tween(LIFT_UP_MS, easing = FastOutSlowInEasing))
            lift.animateTo(0f, tween(LIFT_DOWN_MS, delayMillis = LIFT_HOLD_MS, easing = FastOutSlowInEasing))
        }
    }
    val liftNow = lift.value
    val blinkNow = blink.value
    return this
        .zIndex(liftNow)
        .graphicsLayer {
            val scale = 1f + LIFT_SCALE * liftNow
            scaleX = scale
            scaleY = scale
            alpha = blinkNow
        }
        .drawBehind {
            if (liftNow > 0f) drawRect(DeckColors.surface2.copy(alpha = liftNow))
        }
}

/**
 * A row's rank for [liftOnReorder]: the project's slot in the list, then the row's slot inside the
 * project. Rows only "move" when a project overtakes another or a session re-ranks within its own
 * project, never because a block above folded or gained a row.
 */
fun rowRank(project: Int, row: Int): Int = project * ROWS_PER_PROJECT + row

/** Placement animation for reordering rows: long enough to follow, short enough not to lag the data. */
val REORDER_SLIDE: FiniteAnimationSpec<IntOffset> = tween(SLIDE_MS, easing = FastOutSlowInEasing)

private const val ROWS_PER_PROJECT = 1_000
private const val SLIDE_MS = 450
private const val BLINK_FLOOR = 0.3f
private const val BLINK_OUT_MS = 110
private const val BLINK_IN_MS = 380
private const val LIFT_UP_MS = 160
private const val LIFT_HOLD_MS = 200
private const val LIFT_DOWN_MS = 320
private const val LIFT_SCALE = 0.035f
