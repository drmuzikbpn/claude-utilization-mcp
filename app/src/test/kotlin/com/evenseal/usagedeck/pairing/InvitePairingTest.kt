package com.evenseal.usagedeck.pairing

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class InvitePairingTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val store = MachineStore(context.getSharedPreferences("invite-test", Context.MODE_PRIVATE))
    private val invite = PairingInvite("mbp", listOf("192.168.1.20"), 47292, "a".repeat(64), "AbCdEfGhIjKlMnOpQrSt_-")
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val redeemed =
        MachineConfig("m1", "mbp", "192.168.1.20", 47292, "tok", fp = "a".repeat(64), addrs = invite.addrs)

    @Test
    fun `a redeemed invite is stored, replacing an earlier pairing of the same machine`() = runTest {
        store.add(redeemed.copy(id = "old", token = "stale"))

        val paired = InvitePairing({ redeemed }, store, work).pair(invite)

        assertEquals(redeemed, paired)
        assertEquals(listOf(redeemed), store.machines.value)
    }

    @Test
    fun `a failed redeem stores nothing`() {
        val rejected = DaemonException("unauthorized", 401, null, "run `claude-usage pair` again")
        val pairing = InvitePairing({ throw rejected }, store, work)

        val e = assertThrows(DaemonException::class.java) { runBlocking { pairing.pair(invite) } }

        assertEquals("run `claude-usage pair` again", e.userMessage())
        assertTrue(store.machines.value.isEmpty())
    }

    @Test
    fun `an unexpected failure in the redeem becomes a daemon error instead of escaping`() {
        val pairing = InvitePairing({ throw IllegalArgumentException("boom") }, store, work)

        val e = assertThrows(DaemonException::class.java) { runBlocking { pairing.pair(invite) } }

        assertEquals("internal", e.code)
        assertTrue(e.userMessage().contains("claude-usage pair"))
        assertTrue(store.machines.value.isEmpty())
    }

    @Test
    fun `a failure writing the store becomes a daemon error instead of escaping`() {
        val real = context.getSharedPreferences("invite-test-broken", Context.MODE_PRIVATE)
        val broken = object : SharedPreferences by real {
            override fun edit(): SharedPreferences.Editor = throw IllegalStateException("keystore gone")
        }
        val pairing = InvitePairing({ redeemed }, MachineStore(broken), work)

        val e = assertThrows(DaemonException::class.java) { runBlocking { pairing.pair(invite) } }

        assertEquals("internal", e.code)
    }

    @Test
    fun `cancellation is not swallowed`() {
        val pairing = InvitePairing({ throw CancellationException("gone") }, store, work)

        assertThrows(CancellationException::class.java) { runBlocking { pairing.pair(invite) } }
    }

    @Test
    fun `the same code redeemed twice at once makes one request and both callers get the machine`() = runBlocking {
        val calls = AtomicInteger()
        val gate = CompletableDeferred<Unit>()
        val pairing = InvitePairing({
            calls.incrementAndGet()
            gate.await()
            redeemed
        }, store, work)

        val first = async(Dispatchers.Default) { pairing.pair(invite) }
        val second = async(Dispatchers.Default) { pairing.pair(invite) }
        withTimeout(5_000) { pairing.redeeming.first { it } }
        gate.complete(Unit)

        assertEquals(redeemed, first.await())
        assertEquals(redeemed, second.await())
        assertEquals(1, calls.get())
        withTimeout(5_000) { pairing.redeeming.first { !it } }
        assertEquals(listOf(redeemed), store.machines.value)
    }

    @Test
    fun `different codes are separate redeems`() = runBlocking {
        val calls = AtomicInteger()
        val pairing = InvitePairing({
            calls.incrementAndGet()
            redeemed
        }, store, work)

        pairing.pair(invite)
        pairing.pair(PairingInvite("mbp", invite.addrs, invite.port, invite.fp, "ZyXwVuTsRqPoNmLkJiHg_-"))

        assertEquals(2, calls.get())
    }

    @Test
    fun `a redeem whose caller went away still finishes and stores the machine`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val pairing = InvitePairing({
            gate.await()
            redeemed
        }, store, work)

        val caller = launch(Dispatchers.Default) { pairing.pair(invite) }
        withTimeout(5_000) { pairing.redeeming.first { it } }
        caller.cancelAndJoin()
        gate.complete(Unit)

        withTimeout(5_000) { pairing.redeeming.first { !it } }
        assertEquals(listOf(redeemed), store.machines.value)
    }
}
