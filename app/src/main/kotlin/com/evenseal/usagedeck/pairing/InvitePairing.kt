package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite
import kotlinx.coroutines.CancellationException

/**
 * Redeems a v2 invite (normally `PairingClient.redeem`) and stores the machine it yields,
 * replacing any earlier pairing of the same machine. Nothing is stored when the redeem fails,
 * and the one-time code is never kept: it lives only in the [PairingInvite] passed in.
 *
 * Every failure surfaces as a [DaemonException] — by the time anything else could throw (a bad
 * URL, a keystore write) the code may already be spent, and an escaping exception would crash
 * the kiosk instead of telling the user to run `claude-usage pair` again.
 */
class InvitePairing(
    private val redeem: suspend (PairingInvite) -> MachineConfig,
    private val store: MachineStore
) {
    suspend fun pair(invite: PairingInvite): MachineConfig = try {
        redeem(invite).also { store.pair(it) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: DaemonException) {
        throw e
    } catch (e: Throwable) {
        throw DaemonException("internal", 0, null, null)
    }
}
