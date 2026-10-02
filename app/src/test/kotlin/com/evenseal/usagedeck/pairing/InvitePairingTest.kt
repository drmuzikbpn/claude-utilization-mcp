package com.evenseal.usagedeck.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
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
    private val redeemed =
        MachineConfig("m1", "mbp", "192.168.1.20", 47292, "tok", fp = "a".repeat(64), addrs = invite.addrs)

    @Test
    fun `a redeemed invite is stored, replacing an earlier pairing of the same machine`() = runTest {
        store.add(redeemed.copy(id = "old", token = "stale"))

        val paired = InvitePairing({ redeemed }, store).pair(invite)

        assertEquals(redeemed, paired)
        assertEquals(listOf(redeemed), store.machines.value)
    }

    @Test
    fun `a failed redeem stores nothing`() {
        val pairing =
            InvitePairing({ throw DaemonException("unauthorized", 401, null, "run `claude-usage pair` again") }, store)

        val e = assertThrows(DaemonException::class.java) { runBlocking { pairing.pair(invite) } }

        assertEquals("run `claude-usage pair` again", e.userMessage())
        assertTrue(store.machines.value.isEmpty())
    }
}
