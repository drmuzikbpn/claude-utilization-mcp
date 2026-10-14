// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.kiosk

import android.content.Context
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.ui.setOrChangePin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class PinFlowTest {
    @get:Rule
    val compose = createComposeRule()

    private val app = ApplicationProvider.getApplicationContext<UsageDeckApp>()
    private val graph get() = app.graph

    @Before
    fun clean() {
        app.getSharedPreferences("exit_pin", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun `the first pin is not offered while the two entries differ`() {
        compose.setContent { FirstPinDialog(onSet = {}) }

        compose.onNodeWithContentDescription(ExitGateDefaults.FIRST_PIN).performTextInput("123456")
        compose.onNodeWithContentDescription(ExitGateDefaults.FIRST_PIN_AGAIN).performTextInput("123457")

        compose.onNodeWithText("Set PIN").assertIsNotEnabled()
    }

    @Test
    fun `the first pin is set once both entries are the same six digits`() {
        var chosen: String? = null
        compose.setContent { FirstPinDialog(onSet = { chosen = it }) }

        compose.onNodeWithContentDescription(ExitGateDefaults.FIRST_PIN).performTextInput("123456")
        compose.onNodeWithContentDescription(ExitGateDefaults.FIRST_PIN_AGAIN).performTextInput("123456")
        compose.onNodeWithText("Set PIN").assertIsEnabled().performClick()

        assertEquals("123456", chosen)
    }

    @Test
    fun `settings can set the first pin but cannot replace it without the current one`() {
        assertNull(setOrChangePin(graph, null, "123456"))
        assertTrue(graph.settings.settings.value.pinSet)

        assertEquals("Current PIN is wrong · 4 left", setOrChangePin(graph, null, "999999"))
        assertEquals("Current PIN is wrong · 3 left", setOrChangePin(graph, "000000", "999999"))
        assertEquals(com.evenseal.usagedeck.kiosk.ExitPin.Result.Ok, graph.exitPin.verify("123456"))

        assertNull(setOrChangePin(graph, "123456", "654321"))
        assertEquals(com.evenseal.usagedeck.kiosk.ExitPin.Result.Ok, graph.exitPin.verify("654321"))
    }

    @Test
    fun `guessing the current pin from settings ends in the gate's lockout`() {
        setOrChangePin(graph, null, "123456")
        val answers = (1..5).map { setOrChangePin(graph, "000000", "999999") }

        assertTrue(answers.last()!!.startsWith("Locked out for "))
        assertTrue(setOrChangePin(graph, "123456", "999999")!!.startsWith("Locked out for "))
    }
}
