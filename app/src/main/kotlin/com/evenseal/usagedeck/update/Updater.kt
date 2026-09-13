package com.evenseal.usagedeck.update

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.update.ReleaseChecker
import com.evenseal.usagedeck.core.update.ReleaseInfo
import com.evenseal.usagedeck.core.update.Sha256
import com.evenseal.usagedeck.core.update.Version
import com.evenseal.usagedeck.service.UpdateChecks
import java.io.File
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

sealed interface UpdaterState {
    object Idle : UpdaterState

    object Checking : UpdaterState

    data class Downloading(val version: Version) : UpdaterState

    data class Deferred(val version: Version, val reason: String) : UpdaterState

    data class Installing(val version: Version) : UpdaterState

    data class Failed(val message: String) : UpdaterState
}

/**
 * Polls GitHub for a newer APK, verifies its sha256 and installs it — but never while the user is
 * mid-gesture or an escalation is armed (spec §12). An update that lands in the middle of a hold
 * would lose the hold, so the download waits, already verified, until the deck is idle.
 */
class Updater(
    private val checker: ReleaseChecker,
    private val installed: Version,
    private val installer: ApkInstaller,
    private val cacheDir: File,
    private val client: OkHttpClient,
    /** Returns null when it is safe to install, otherwise the reason to wait. */
    private val deferWhile: () -> String?,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val intervalMs: Long = 600_000
) : UpdateChecks {
    private val _state = MutableStateFlow<UpdaterState>(UpdaterState.Idle)
    val state: StateFlow<UpdaterState> = _state.asStateFlow()

    override val label: StateFlow<String> = _state
        .map(::describe)
        .stateIn(scope, SharingStarted.Eagerly, describe(UpdaterState.Idle))

    private var job: Job? = null

    /** A verified APK waiting for the deck to go quiet. */
    private var staged: Staged? = null

    private data class Staged(val version: Version, val apk: File)

    fun start() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                val waiting = staged
                if (waiting != null) installOrDefer(waiting) else checkNow()
                // A verified APK that is only waiting for the deck to go quiet re-checks every
                // 30 s; everything else waits out the full jittered cycle.
                delay(if (staged != null) DEFER_RETRY_MS else jittered())
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    override suspend fun checkNow() {
        _state.value = UpdaterState.Checking

        val info = checker.latest()
        if (info == null) {
            _state.value = UpdaterState.Failed("Could not reach GitHub.")
            return
        }
        if (!checker.isNewer(info.version, installed)) {
            _state.value = UpdaterState.Idle
            return
        }

        _state.value = UpdaterState.Downloading(info.version)
        val apk = download(info)
        if (apk == null) {
            _state.value = UpdaterState.Failed("Download failed for ${info.version}.")
            return
        }

        val expected = checker.expectedSha256(info)
        if (expected == null) {
            apk.delete()
            _state.value = UpdaterState.Failed("Release ${info.version} has no checksum.")
            return
        }
        if (!Sha256.hexOf(apk).equals(expected, ignoreCase = true)) {
            apk.delete()
            _state.value = UpdaterState.Failed("Checksum mismatch for ${info.version}; not installing.")
            return
        }

        val ready = Staged(info.version, apk)
        staged = ready
        installOrDefer(ready)
    }

    private suspend fun installOrDefer(ready: Staged) {
        val reason = deferWhile()
        if (reason != null) {
            _state.value = UpdaterState.Deferred(ready.version, reason)
            return
        }
        _state.value = UpdaterState.Installing(ready.version)
        installer.install(ready.apk)
            .onSuccess { staged = null }
            .onFailure {
                staged = null
                _state.value = UpdaterState.Failed("Install failed: ${it.message ?: "unknown error"}")
            }
    }

    /**
     * The APK is kept at a stable name so a technician can `adb install -r` it after a failed
     * self-update; older downloads are removed so the cache cannot grow without bound.
     */
    private suspend fun download(info: ReleaseInfo): File? = withContext(Dispatchers.IO) {
        runCatching {
            cacheDir.mkdirs()
            cacheDir.listFiles()
                ?.filter { it.name.endsWith(".apk") && it.name != APK_NAME }
                ?.forEach { it.delete() }

            val target = File(cacheDir, APK_NAME)
            val request = Request.Builder().url(info.apkUrl).get().build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@runCatching null
                val body = response.body ?: return@runCatching null
                target.outputStream().use { out -> body.byteStream().copyTo(out) }
            }
            target
        }.getOrNull()
    }

    /** ±10 % so a fleet of decks does not stampede the GitHub API on the same second. */
    private fun jittered(): Long {
        val spread = (intervalMs * JITTER).toLong().coerceAtLeast(1L)
        return intervalMs - spread + Random(clock.now().toEpochMilli()).nextLong(2 * spread)
    }

    private fun describe(state: UpdaterState): String = when (state) {
        UpdaterState.Idle -> "up to date ($installed)"
        UpdaterState.Checking -> "checking…"
        is UpdaterState.Downloading -> "downloading ${state.version}"
        is UpdaterState.Deferred -> "${state.version} ready · waiting (${state.reason})"
        is UpdaterState.Installing -> "installing ${state.version}"
        is UpdaterState.Failed -> state.message
    }

    companion object {
        const val APK_NAME = "last-update.apk"

        /** Spec §12: a deferred update re-checks every 30 s rather than waiting a whole cycle. */
        const val DEFER_RETRY_MS = 30_000L

        private const val JITTER = 0.10
    }
}
