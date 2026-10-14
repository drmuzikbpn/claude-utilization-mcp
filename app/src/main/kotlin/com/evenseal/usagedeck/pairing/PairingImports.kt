// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.pairing.PairingInvite
import com.evenseal.usagedeck.pairing.PairingImport.Companion.loggable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * What happens to a sideloaded pairing file once [PairingImport] has consumed it.
 *
 * A link for a machine the deck does not know is redeemed and added. A link that would replace a
 * machine already paired is **not** redeemed: it waits in [pending] until the person at the
 * screen confirms a dialog naming the old machine and the new one. Whoever can drop a file must
 * not thereby be able to swap a paired machine for their own. Declining discards the link with
 * its code unspent. Only names are ever logged.
 */
class PairingImports(
    private val import: PairingImport,
    private val store: MachineStore,
    private val pairing: InvitePairing,
    private val scope: CoroutineScope,
    private val log: (String) -> Unit = {}
) {
    /** A consumed link that is waiting for the on-screen answer. */
    class Pending internal constructor(
        internal val invite: PairingInvite,
        internal val targetId: String,
        val oldName: String
    ) {
        val newName: String get() = invite.name
    }

    private val _pending = MutableStateFlow<Pending?>(null)
    val pending: StateFlow<Pending?> = _pending.asStateFlow()

    /**
     * Looks for a file and deals with it. Called on a timer while the deck is in the foreground:
     * a kiosk that is never left never gets another `onResume`. While a question is on screen
     * the next file is left where it is.
     */
    @Synchronized
    fun poll() {
        if (_pending.value != null) return
        when (val result = import.consume()) {
            PairingImport.Result.Nothing -> Unit
            is PairingImport.Result.Rejected -> log("pairing import rejected: ${loggable(result.reason)}")
            is PairingImport.Result.Redeem -> {
                val target = store.wouldReplace(result.invite)
                if (target == null) {
                    redeem(result.invite, replacing = null)
                } else {
                    log("pairing import for ${loggable(result.invite.name)} waits for confirmation")
                    _pending.value = Pending(result.invite, target.id, target.name)
                }
            }
        }
    }

    /** The person at the screen agreed: redeem the link and replace the named row. */
    @Synchronized
    fun confirm() {
        val asked = _pending.value ?: return
        _pending.value = null
        redeem(asked.invite, replacing = asked.targetId)
    }

    /** The person at the screen refused: the link is dropped, its code never sent. */
    @Synchronized
    fun decline() {
        val asked = _pending.value ?: return
        _pending.value = null
        log("pairing import for ${loggable(asked.newName)} declined")
    }

    private fun redeem(invite: PairingInvite, replacing: String?) {
        scope.launch {
            try {
                // Without a confirmation nothing may be replaced, even a row that appeared since.
                val paired = pairing.pair(invite, replacing = replacing, mayReplace = replacing != null)
                log("paired ${loggable(paired.name)} from import file")
            } catch (e: DaemonException) {
                log("pairing import of ${loggable(invite.name)} failed: ${loggable(e.userMessage())}")
            }
        }
    }
}
