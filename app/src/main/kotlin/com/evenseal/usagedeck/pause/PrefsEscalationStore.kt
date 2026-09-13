package com.evenseal.usagedeck.pause

import android.content.SharedPreferences
import android.util.Log
import com.evenseal.usagedeck.core.pause.Escalation
import com.evenseal.usagedeck.core.pause.EscalationStore
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Escalations on disk, so a soft pause that is 40 s into its 90 s countdown still escalates
 * after the service is killed and restarted (spec §9).
 */
class PrefsEscalationStore(private val prefs: SharedPreferences) : EscalationStore {
    override fun load(): List<Escalation> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return runCatching {
            json.decodeFromString(listSerializer, raw).map {
                Escalation(it.machineId, it.scope, Instant.ofEpochMilli(it.fireAtMillis))
            }
        }.onFailure { Log.w(TAG, "dropping unreadable escalation store", it) }
            .getOrDefault(emptyList())
    }

    override fun save(list: List<Escalation>) {
        val stored = list.map { StoredEscalation(it.machineId, it.scope, it.fireAt.toEpochMilli()) }
        prefs.edit().putString(KEY, json.encodeToString(listSerializer, stored)).apply()
    }

    @Serializable
    private data class StoredEscalation(val machineId: String, val scope: String, val fireAtMillis: Long)

    private companion object {
        const val KEY = "escalations"
        const val TAG = "UsageDeckEscalations"

        val json = Json { ignoreUnknownKeys = true }
        val listSerializer = ListSerializer(StoredEscalation.serializer())
    }
}
