package com.evenseal.usagedeck.core.update

import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

data class ReleaseInfo(
    val version: Version,
    val apkUrl: String,
    val sumsUrl: String,
    val apkName: String
)

@Serializable
private data class AssetDto(val name: String = "", val browser_download_url: String = "")

@Serializable
private data class ReleaseDto(
    val tag_name: String = "",
    val assets: List<AssetDto> = emptyList(),
    val draft: Boolean = false,
    val prerelease: Boolean = false
)

private val ReleaseJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

/**
 * Finds the newest GitHub release of the phone's own APK. The repo is shared with the daemon
 * (spec §23.17): daemon releases are tagged `v<semver>`, APK releases `deck-<version>` and flagged
 * pre-release so the daemon's `/releases/latest` never sees them. This side lists releases and
 * considers `deck-` tags only, so a daemon tarball never looks installable here either. Anything
 * unexpected — a network error, no `deck-` release, a release with no APK — reads as "nothing to
 * install" (`null`), never as an exception.
 */
class ReleaseChecker(
    private val repo: String,
    private val client: OkHttpClient,
    private val apkPrefix: String = "usage-deck",
    private val baseUrl: String = "https://api.github.com"
) {
    suspend fun latest(): ReleaseInfo? {
        val body = get("$baseUrl/repos/$repo/releases?per_page=$PAGE") ?: return null
        val releases = runCatching { ReleaseJson.decodeFromString<List<ReleaseDto>>(body) }.getOrNull() ?: return null
        return releases
            .asSequence()
            .filter { !it.draft && it.tag_name.startsWith(TAG_PREFIX, ignoreCase = true) }
            .mapNotNull { release -> Version.parse(release.tag_name.drop(TAG_PREFIX.length))?.let { it to release } }
            .sortedByDescending { it.first }
            .firstNotNullOfOrNull { (version, release) -> info(version, release) }
    }

    private fun info(version: Version, release: ReleaseDto): ReleaseInfo? {
        val apk = release.assets.firstOrNull {
            it.name.startsWith(apkPrefix) && it.name.endsWith(".apk")
        } ?: return null
        val sums = release.assets.firstOrNull { it.name == "${apk.name}.sha256" }
            ?: release.assets.firstOrNull { it.name == SUMS_NAME }
            ?: return null
        return ReleaseInfo(version, apk.browser_download_url, sums.browser_download_url, apk.name)
    }

    /**
     * The sha256 hex for [ReleaseInfo.apkName]: from `usage-deck.apk.sha256` (`<hex>  <name>` or a
     * bare hex) or a multi-file `SHA256SUMS`. A line naming a different file never matches.
     */
    suspend fun expectedSha256(info: ReleaseInfo): String? {
        val body = get(info.sumsUrl) ?: return null
        return body.lineSequence()
            .mapNotNull { line ->
                val parts = line.trim().split(Regex("\\s+"), limit = 2)
                when {
                    parts.size == 2 && parts[1].trim().removePrefix("*") == info.apkName -> parts[0]
                    parts.size == 1 && HEX.matches(parts[0]) -> parts[0]
                    else -> null
                }
            }
            .firstOrNull()
    }

    fun isNewer(candidate: Version, installed: Version) = candidate > installed

    private suspend fun get(url: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            client.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
                if (response.isSuccessful) response.body?.string() else null
            }
        }.getOrNull()
    }

    companion object {
        /** Spec §23.17: the APK's tag namespace inside the daemon's repo. */
        const val TAG_PREFIX = "deck-"
        private const val SUMS_NAME = "SHA256SUMS"
        private const val PAGE = 100
        private val HEX = Regex("^[0-9a-fA-F]{64}$")
    }
}

object Sha256 {
    private const val HEX_MASK = 0xff
    private const val BUFFER_BYTES = 64 * 1024

    fun hex(bytes: ByteArray): String = toHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun hexOf(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(BUFFER_BYTES)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return toHex(digest.digest())
    }

    private fun toHex(bytes: ByteArray): String =
        bytes.joinToString("") { ((it.toInt() and HEX_MASK) + 0x100).toString(16).substring(1) }
}
