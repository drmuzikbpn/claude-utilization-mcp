package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite

/**
 * Redeems a v2 invite (normally `PairingClient.redeem`) and stores the machine it yields,
 * replacing any earlier pairing of the same machine. Nothing is stored when the redeem fails,
 * and the one-time code is never kept: it lives only in the [PairingInvite] passed in.
 */
class InvitePairing(
    private val redeem: suspend (PairingInvite) -> MachineConfig,
    private val store: MachineStore
) {
    suspend fun pair(invite: PairingInvite): MachineConfig = redeem(invite).also { store.pair(it) }
}
