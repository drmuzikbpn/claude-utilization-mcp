package com.evenseal.usagedeck.core.pairing

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/**
 * What `claude-usage pair` puts in its QR (daemon §23.47, contract v2):
 * `usagedeck://pair?v=2&name=…&addrs=…&port=…&fp=…&code=…`.
 *
 * It never carries the bearer. [code] is single use and expires after five minutes; it is traded
 * for the token over HTTPS pinned to [fp] ([PairingClient]). [addrs] are in the daemon's order —
 * LAN IPv4, `<host>.local`, tailnet IPv4, other literals, loopback last — and every one presents
 * the same certificate. Nothing may log or persist [code]; [toString] redacts it.
 */
class PairingInvite(
    val name: String,
    val addrs: List<String>,
    /** The daemon's HTTPS port (`tls.port`), shared by every address. */
    val port: Int,
    /** Lowercase hex SHA-256 of the daemon certificate's SubjectPublicKeyInfo. */
    val fp: String,
    val code: String
) {
    override fun toString(): String = "PairingInvite(name=$name, addrs=$addrs, port=$port, fp=$fp, code=<redacted>)"

    override fun equals(other: Any?): Boolean = other is PairingInvite &&
        name == other.name && addrs == other.addrs && port == other.port && fp == other.fp && code == other.code

    override fun hashCode(): Int = listOf(name, addrs, port, fp, code).hashCode()

    companion object {
        const val SCHEME = "usagedeck"
        const val SUPPORTED_VERSION = 2

        private val HEX64 = Regex("^[0-9a-f]{64}$")
        private val BASE64URL = Regex("^[A-Za-z0-9_-]{22,256}$")

        /** Whether [text] is meant as a v2 link at all, so a malformed one gets this parser's message. */
        fun isLink(text: String): Boolean = text.trim().lowercase().startsWith("$SCHEME:")

        /**
         * Parses a scanned or sideloaded link. Every rejection is a [Result.failure] whose message
         * the pairing screen shows verbatim.
         */
        fun parse(text: String): Result<PairingInvite> = runCatching {
            val uri = try {
                URI(text.trim())
            } catch (e: URISyntaxException) {
                throw IllegalArgumentException(NOT_A_LINK, e)
            }
            require(uri.scheme.equals(SCHEME, ignoreCase = true) && uri.host.equals("pair", ignoreCase = true)) {
                NOT_A_LINK
            }
            val query = queryOf(uri.rawQuery.orEmpty())

            val v = requireNotNull(query["v"]?.toIntOrNull()) { "The pairing link has no version." }
            require(v == SUPPORTED_VERSION) { "This pairing link is version $v; update Usage Deck to use it." }

            val name = query["name"].orEmpty().trim()
            require(name.isNotEmpty()) { "The pairing link has no machine name." }

            val addrs = query["addrs"].orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }
            require(addrs.isNotEmpty()) { "The pairing link has no addresses." }
            addrs.firstOrNull { !HostValidation.isValid(it) }?.let {
                throw IllegalArgumentException("The pairing link has an invalid address '$it'.")
            }

            val port = query["port"]?.toIntOrNull()
            require(port != null && port in 1..65535) { "The pairing link has an invalid port." }

            val fp = query["fp"].orEmpty().lowercase()
            require(HEX64.matches(fp)) { "The pairing link has an invalid certificate fingerprint." }

            val code = query["code"].orEmpty()
            require(BASE64URL.matches(code)) { "The pairing link has an invalid pairing code." }

            PairingInvite(name, addrs.distinctBy { it.lowercase() }, port, fp, code)
        }

        private const val NOT_A_LINK = "That isn't a Usage Deck pairing link. Run `claude-usage pair` on the Mac."

        /** First value wins for a repeated key, as on iOS. */
        private fun queryOf(raw: String): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            raw.split('&').filter { it.isNotEmpty() }.forEach { pair ->
                val eq = pair.indexOf('=')
                val key = decode(if (eq < 0) pair else pair.substring(0, eq))
                val value = if (eq < 0) "" else decode(pair.substring(eq + 1))
                out.putIfAbsent(key, value)
            }
            return out
        }

        // `encodeURIComponent` never emits '+', so a literal '+' is data, not a space: keep it so a
        // code containing one is rejected rather than silently altered.
        private fun decode(s: String): String = URLDecoder.decode(s.replace("+", "%2B"), Charsets.UTF_8.name())
    }
}
