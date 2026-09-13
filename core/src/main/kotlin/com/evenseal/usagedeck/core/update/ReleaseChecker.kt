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
private data class ReleaseDto(val tag_name: String = "", val assets: List<AssetDto> = emptyList())

private val ReleaseJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

/**
 * Reads the latest GitHub release for the phone's own APK. Anything unexpected — a network
 * error, an unparseable tag, a release with no APK — reads as "nothing to install" (`null`),
 * never as an exception.
 */
class ReleaseChecker(
    private val repo: String,
    private val client: OkHttpClient,
    private val apkPrefix: String = "usage-deck-",
    private val baseUrl: String = "https://api.github.com"
) {
    suspend fun latest(): ReleaseInfo? {
        val body = get("$baseUrl/repos/$repo/releases/latest") ?: return null
        val release = runCatching { ReleaseJson.decodeFromString<ReleaseDto>(body) }.getOrNull() ?: return null
        val version = Version.parse(release.tag_name) ?: return null
        val apk = release.assets.firstOrNull {
            it.name.startsWith(apkPrefix) && it.name.endsWith(".apk")
        } ?: return null
        val sums = release.assets.firstOrNull { it.name == SUMS_NAME } ?: return null
        return ReleaseInfo(version, apk.browser_download_url, sums.browser_download_url, apk.name)
    }

    /** The sha256 hex for [ReleaseInfo.apkName] out of the release's `SHA256SUMS`. */
    suspend fun expectedSha256(info: ReleaseInfo): String? {
        val body = get(info.sumsUrl) ?: return null
        return body.lineSequence()
            .mapNotNull { line ->
                val parts = line.trim().split(Regex("\\s+"), limit = 2)
                if (parts.size == 2 && parts[1].trim() == info.apkName) parts[0] else null
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

    private companion object {
        const val SUMS_NAME = "SHA256SUMS"
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
