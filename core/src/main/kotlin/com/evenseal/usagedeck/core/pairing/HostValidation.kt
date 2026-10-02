package com.evenseal.usagedeck.core.pairing

/** IPv4 literals and DNS host names (including `.local`). Shared by the v1 and v2 pairing parsers. */
object HostValidation {
    private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

    private val HOSTNAME = Regex(
        """^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?""" +
            """(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$"""
    )

    fun isValid(addr: String): Boolean {
        if (addr.isBlank() || addr.length > 253) return false
        val ipv4 = IPV4.matchEntire(addr)
        if (ipv4 != null) {
            return ipv4.groupValues.drop(1).all { (it.toIntOrNull() ?: return false) in 0..255 }
        }
        // A bare dotted-decimal prefix like "100.1.1" is a broken IPv4 address, not a hostname.
        if (addr.split('.').all { it.isNotEmpty() && it.all(Char::isDigit) }) return false
        return HOSTNAME.matches(addr)
    }
}
