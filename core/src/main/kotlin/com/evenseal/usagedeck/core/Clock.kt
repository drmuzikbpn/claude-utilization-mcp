package com.evenseal.usagedeck.core

import java.time.Instant

fun interface Clock {
    fun now(): Instant
}

object SystemClock : Clock {
    override fun now(): Instant = Instant.now()
}

class FakeClock(var current: Instant) : Clock {
    override fun now(): Instant = current

    fun advance(seconds: Long) {
        current = current.plusSeconds(seconds)
    }
}
