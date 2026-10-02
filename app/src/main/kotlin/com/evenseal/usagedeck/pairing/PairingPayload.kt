package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.HostValidation
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The QR that `claude-usage configure pairing` prints. Spec §6.3 — it carries a live bearer token,
 * so it is scanned off-camera and rotated if it was ever exposed.
 */
@Serializable
data class PairingPayload(
    val v: Int,
    val name: String,
    val addr: String,
    val port: Int,
    val token: String
) {
    fun toConfig(id: String = UUID.randomUUID().toString()) =
        MachineConfig(id = id, name = name, addr = addr, port = port, token = token)

    companion object {
        const val SUPPORTED_VERSION = 1

        private val json = Json { ignoreUnknownKeys = true }

        /**
         * Parses the raw QR text. Every rejection is a [Result.failure] carrying a message the
         * pairing screen can show verbatim.
         */
        fun parse(text: String): Result<PairingPayload> = runCatching {
            val payload = json.decodeFromString(serializer(), text)
            require(payload.v == SUPPORTED_VERSION) {
                "unsupported pairing QR version ${payload.v} — update Usage Deck"
            }
            require(payload.token.isNotBlank()) { "pairing QR has no token" }
            require(payload.port in 1..65535) { "pairing QR has an invalid port ${payload.port}" }
            require(HostValidation.isValid(payload.addr)) { "pairing QR has an invalid address '${payload.addr}'" }
            payload
        }
    }
}
