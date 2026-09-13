package com.evenseal.usagedeck.core.update

/**
 * `MAJOR.MINOR.<commit-count>+<short-sha>`, the scheme both the daemon and this app use.
 * Ordering is by the three numbers only; the sha is a label, not a rank.
 */
data class Version(
    val major: Int,
    val minor: Int,
    val build: Int,
    val sha: String
) : Comparable<Version> {
    override fun compareTo(other: Version): Int =
        compareValuesBy(this, other, Version::major, Version::minor, Version::build)

    override fun toString(): String = "$major.$minor.$build" + if (sha.isEmpty()) "" else "+$sha"

    companion object {
        private val PATTERN = Regex("""^v?(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.\-]+))?$""")

        /** Accepts `v0.1.417+3f9c2ab`, `0.1.417+3f9c2ab` and `0.1.417`; anything else is `null`. */
        fun parse(s: String): Version? {
            val m = PATTERN.matchEntire(s.trim()) ?: return null
            return Version(
                major = m.groupValues[1].toIntOrNull() ?: return null,
                minor = m.groupValues[2].toIntOrNull() ?: return null,
                build = m.groupValues[3].toIntOrNull() ?: return null,
                sha = m.groupValues[4]
            )
        }
    }
}
