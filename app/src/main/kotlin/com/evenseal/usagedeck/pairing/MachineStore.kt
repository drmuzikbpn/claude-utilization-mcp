package com.evenseal.usagedeck.pairing

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.evenseal.usagedeck.core.model.MachineConfig
import java.io.IOException
import java.security.GeneralSecurityException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * The paired machines, held in `EncryptedSharedPreferences` because each row carries a live
 * daemon bearer token. Spec §6.3.
 */
class MachineStore(private val prefs: SharedPreferences) {
    private val _machines = MutableStateFlow(load())
    val machines: StateFlow<List<MachineConfig>> = _machines.asStateFlow()

    fun add(config: MachineConfig) {
        mutate { current -> current.filterNot { it.id == config.id } + config }
    }

    fun remove(id: String) {
        mutate { current -> current.filterNot { it.id == id } }
    }

    fun rename(id: String, name: String) {
        mutate { current -> current.map { if (it.id == id) it.copy(name = name) else it } }
    }

    private fun mutate(block: (List<MachineConfig>) -> List<MachineConfig>) {
        val next = block(_machines.value)
        prefs.edit()
            .putString(KEY_MACHINES, json.encodeToString(listSerializer, next.map { it.stored() }))
            .apply()
        _machines.value = next
    }

    private fun load(): List<MachineConfig> {
        val raw = prefs.getString(KEY_MACHINES, null) ?: return emptyList()
        return runCatching { json.decodeFromString(listSerializer, raw).map { it.config() } }
            .onFailure { Log.w(TAG, "dropping unreadable machine store", it) }
            .getOrDefault(emptyList())
    }

    @Serializable
    private data class StoredMachine(
        val id: String,
        val name: String,
        val addr: String,
        val port: Int,
        val token: String
    )

    private fun MachineConfig.stored() = StoredMachine(id, name, addr, port, token)

    private fun StoredMachine.config() = MachineConfig(id, name, addr, port, token)

    companion object {
        const val PREFS_NAME = "machines"

        private const val KEY_MACHINES = "machines"
        private const val TAG = "UsageDeckMachines"

        private val json = Json { ignoreUnknownKeys = true }
        private val listSerializer = ListSerializer(StoredMachine.serializer())

        fun open(context: Context): MachineStore = MachineStore(encryptedPrefs(context, PREFS_NAME))
    }
}

/**
 * Opens [name] as `EncryptedSharedPreferences`, falling back to plain prefs when the AndroidKeyStore
 * is unavailable — which is the case under Robolectric, and on a device whose keystore has been
 * wiped. The fallback keeps the app usable; on the real kiosk the encrypted path always wins.
 */
internal fun encryptedPrefs(context: Context, name: String): SharedPreferences {
    val app = context.applicationContext
    return try {
        val key = MasterKey.Builder(app)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            app,
            name,
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: GeneralSecurityException) {
        Log.w("UsageDeckPrefs", "keystore unavailable, falling back to plain prefs for $name", e)
        app.getSharedPreferences(name, Context.MODE_PRIVATE)
    } catch (e: IOException) {
        Log.w("UsageDeckPrefs", "keystore unreadable, falling back to plain prefs for $name", e)
        app.getSharedPreferences(name, Context.MODE_PRIVATE)
    }
}
