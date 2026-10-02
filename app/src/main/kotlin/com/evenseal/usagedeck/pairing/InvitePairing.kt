package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Redeems a v2 invite (normally `PairingClient.redeem`) and stores the machine it yields,
 * replacing any earlier pairing of the same machine. Nothing is stored when the redeem fails,
 * and the one-time code is never kept: it lives only in the [PairingInvite] passed in and, while
 * its redeem runs, as the key that de-duplicates it.
 *
 * Redeems run on [scope], not the caller's: a code that has been sent must finish and store its
 * token even if the pairing screen closes or rotates. A second [pair] of a code already in flight
 * (a re-entered screen, the sideload racing a scan) joins the first instead of spending it twice.
 *
 * Every failure surfaces as a [DaemonException] — by the time anything else could throw (a bad
 * URL, a keystore write) the code may already be spent, and an escaping exception would crash
 * the kiosk instead of telling the user to run `claude-usage pair` again.
 */
class InvitePairing(
    private val redeem: suspend (PairingInvite) -> MachineConfig,
    private val store: MachineStore,
    scope: CoroutineScope
) {
    // A supervisor child, so one failed redeem never cancels the scope it runs in.
    private val work = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
    private val lock = Any()
    private val running = HashMap<String, Deferred<MachineConfig>>()

    private val _redeeming = MutableStateFlow(false)

    /** True while any redeem is in flight; the pairing screen keeps Scan disabled meanwhile. */
    val redeeming: StateFlow<Boolean> = _redeeming.asStateFlow()

    suspend fun pair(invite: PairingInvite): MachineConfig {
        val job = synchronized(lock) {
            running.getOrPut(invite.code) {
                work.async(start = CoroutineStart.LAZY) { redeemAndStore(invite) }.also { job ->
                    job.invokeOnCompletion {
                        synchronized(lock) {
                            running.remove(invite.code)
                            _redeeming.value = running.isNotEmpty()
                        }
                    }
                    _redeeming.value = true
                }
            }
        }
        job.start()
        return job.await()
    }

    private suspend fun redeemAndStore(invite: PairingInvite): MachineConfig = try {
        redeem(invite).also { store.pair(it) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: DaemonException) {
        throw e
    } catch (e: Throwable) {
        throw DaemonException("internal", 0, null, null)
    }
}
