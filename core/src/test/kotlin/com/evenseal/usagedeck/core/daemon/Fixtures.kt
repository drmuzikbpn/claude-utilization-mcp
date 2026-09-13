package com.evenseal.usagedeck.core.daemon

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

/** Reads a fixture copied verbatim from the daemon repo's `test/fixtures/`. */
object Fixtures {
    fun text(name: String): String = Fixtures::class.java.getResource("/fixtures/$name")!!.readText()

    /** One named case out of `errors.json`, as the raw response body the daemon would send. */
    fun errorBody(name: String): String =
        Json.parseToJsonElement(text("errors.json")).jsonObject.getValue(name).jsonObject.getValue("body").toString()

    /** The HTTP status that goes with [errorBody]. */
    fun errorStatus(name: String): Int =
        Json.parseToJsonElement(text("errors.json")).jsonObject.getValue(name).jsonObject
            .getValue("status").toString().toInt()
}
