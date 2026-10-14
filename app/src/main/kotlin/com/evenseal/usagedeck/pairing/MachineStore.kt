// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * The paired machines, held in `EncryptedSharedPreferences` because each row carries a live
 * daemon bearer token, with the daemon's certificate pin and addresses. Spec §6.3.
 *
 * A row stored by the retired plain-HTTP pairing has no pin. It is kept — the owner must be able
 * to see which machine needs pairing again — but it is no longer a pairing: its bearer is
 * scrubbed the first time the store loads, and nothing ever connects to it.
 */
class MachineStore(private val prefs: SharedPreferences) {
    private val lock = Any()
    private val _machines = MutableStateFlow(load())
    val machines: StateFlow<List<MachineConfig>> = _machines.asStateFlow()

    fun add(config: MachineConfig) {
        mutate { current -> current.filterNot { it.id == config.id } + config }
    }

    /**
     * Stores a freshly paired machine and returns the row as stored. A row that is the same
     * machine is replaced in place: the same certificate key, the same address and port, or —
     * pairing a retired row again — a keyless row whose (non-loopback) address is one of the new
     * pairing's addresses, whatever its port (retired rows sat on the HTTP port).
     * The replacement keeps that row's id, so escalations, alerts and burn history survive a
     * re-pair, and takes the daemon's current name; any further matching rows are dropped.
     *
     * With [mayReplace] false nothing is replaced: the machine is added as a new row even if it
     * matches one. That is for a pairing nobody confirmed on screen (see [PairingImports]).
     */
    fun pair(config: MachineConfig, mayReplace: Boolean = true): MachineConfig =
        if (mayReplace) store(config, replacing = null) else config.also { add(it) }

    /**
     * The row [invite] would replace if it were redeemed and [pair]ed, or null when it would be
     * added as a new machine. Asked before the code is spent, so a replacement can be confirmed.
     */
    fun wouldReplace(invite: PairingInvite): MachineConfig? {
        val addrs = invite.addrs.map { it.lowercase() }.toSet()
        val routable = addrs.filterNot(::isLoopback).toSet()
        return _machines.value.firstOrNull { old ->
            old.fp == invite.fp ||
                (old.addr.lowercase() in addrs && old.port == invite.port) ||
                (old.fp == null && old.addr.lowercase() in routable)
        }
    }

    /**
     * A re-pair started from a machine's Re-pair card: [config] replaces row [id] whatever it
     * matches — when the certificate *and* the address both changed nothing else would — keeping
     * that id, and any other row that is the same machine goes. If [id] is gone, this is [pair].
     */
    fun replace(id: String, config: MachineConfig): MachineConfig = store(config, replacing = id)

    private fun store(config: MachineConfig, replacing: String?): MachineConfig {
        val addrs = config.candidates.filterNot(::isLoopback).map { it.lowercase() }.toSet()
        fun sameMachine(old: MachineConfig) = (config.fp != null && old.fp == config.fp) ||
            (old.addr.equals(config.addr, ignoreCase = true) && old.port == config.port) ||
            (config.fp != null && old.fp == null && old.addr.lowercase() in addrs)

        var stored = config
        mutate(durable = true) { current ->
            val target = current.firstOrNull { it.id == replacing } ?: current.firstOrNull(::sameMachine)
            if (target == null) {
                current + config
            } else {
                stored = config.copy(id = target.id)
                current.mapNotNull { old ->
                    when {
                        old === target -> stored
                        sameMachine(old) -> null
                        else -> old
                    }
                }
            }
        }
        return stored
    }

    fun remove(id: String) {
        mutate { current -> current.filterNot { it.id == id } }
    }

    fun rename(id: String, name: String) {
        mutate { current -> current.map { if (it.id == id) it.copy(name = name) else it } }
    }

    /**
     * Read-modify-write under one lock, so two writers (the sideload redeem and the UI, say)
     * cannot each start from the same list and drop the other's row. [durable] writes commit
     * synchronously: a pairing's token is not in memory only while a crash could still lose it.
     */
    private fun mutate(durable: Boolean = false, block: (List<MachineConfig>) -> List<MachineConfig>) {
        synchronized(lock) {
            val next = block(_machines.value)
            val editor = prefs.edit()
                .putString(KEY_MACHINES, json.encodeToString(listSerializer, next.map { it.stored() }))
            if (durable) editor.commit() else editor.apply()
            _machines.value = next
        }
    }

    private fun load(): List<MachineConfig> {
        val raw = prefs.getString(KEY_MACHINES, null) ?: return emptyList()
        val stored = runCatching { json.decodeFromString(listSerializer, raw) }
            .onFailure { Log.w(TAG, "dropping unreadable machine store", it) }
            .getOrDefault(emptyList())
        // A retired row keeps its place and its name, never its bearer: that token was only ever
        // good for plain HTTP, which the deck no longer speaks.
        val scrubbed = stored.map { if (it.fp == null && it.token.isNotEmpty()) it.copy(token = "") else it }
        if (scrubbed != stored) {
            prefs.edit().putString(KEY_MACHINES, json.encodeToString(listSerializer, scrubbed)).commit()
        }
        return scrubbed.map { it.config() }
    }

    @Serializable
    private data class StoredMachine(
        val id: String,
        val name: String,
        val addr: String,
        val port: Int,
        val token: String,
        // Absent on rows stored by the retired plain-HTTP pairing; such a row must be paired again.
        val fp: String? = null,
        val addrs: List<String> = emptyList()
    )

    private fun MachineConfig.stored() = StoredMachine(id, name, addr, port, token, fp, addrs)

    private fun StoredMachine.config() = MachineConfig(id, name, addr, port, token, fp, addrs)

    companion object {
        const val PREFS_NAME = "machines"

        private const val KEY_MACHINES = "machines"
        private const val TAG = "UsageDeckMachines"

        private val json = Json { ignoreUnknownKeys = true }

        private fun isLoopback(host: String): Boolean = host.lowercase().let {
            it == "localhost" || it.endsWith(".localhost") || it.startsWith("127.") || it == "::1"
        }
        private val listSerializer = ListSerializer(StoredMachine.serializer())

        fun open(context: Context): MachineStore = MachineStore(encryptedPrefs(context, PREFS_NAME))
    }
}
