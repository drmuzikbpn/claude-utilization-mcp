package com.evenseal.usagedeck.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PairingImportTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val dir = File(context.filesDir, "import-test").apply { mkdirs() }
    private val store = MachineStore(context.getSharedPreferences("import-test", Context.MODE_PRIVATE))
    private val import = PairingImport(dir, store)

    private fun drop(text: String) = File(dir, PairingImport.FILE_NAME).writeText(text)

    @Test
    fun `no file is a no-op`() {
        assertEquals(PairingImport.Result.Nothing, import.consume())
        assertTrue(store.machines.value.isEmpty())
    }

    @Test
    fun `a valid payload is added and the file removed`() {
        drop("""{"v":1,"name":"mbp.tail.ts.net","addr":"192.0.2.10","port":47291,"token":"secret"}""")
        assertEquals(PairingImport.Result.Imported("mbp.tail.ts.net"), import.consume())
        val m = store.machines.value.single()
        assertEquals("192.0.2.10", m.addr)
        assertEquals(47291, m.port)
        assertEquals("secret", m.token)
        assertFalse(File(dir, PairingImport.FILE_NAME).exists())
    }

    @Test
    fun `re-importing the same addr and port replaces the token instead of duplicating`() {
        drop("""{"v":1,"name":"mbp","addr":"192.0.2.10","port":47291,"token":"old"}""")
        import.consume()
        drop("""{"v":1,"name":"mbp","addr":"192.0.2.10","port":47291,"token":"new"}""")
        import.consume()
        assertEquals(1, store.machines.value.size)
        assertEquals("new", store.machines.value.single().token)
    }

    @Test
    fun `a file in the external files dir is consumed when the private dir has none`() {
        val external = File(context.filesDir, "import-test-external").apply { mkdirs() }
        File(external, PairingImport.FILE_NAME)
            .writeText("""{"v":1,"name":"studio","addr":"192.0.2.20","port":47291,"token":"s"}""")

        val result = PairingImport(listOf(dir, external), store).consume()

        assertEquals(PairingImport.Result.Imported("studio"), result)
        assertFalse(File(external, PairingImport.FILE_NAME).exists())
    }

    @Test
    fun `an invalid payload is rejected and the file still removed`() {
        drop("""{"v":2,"name":"x","addr":"1.2.3.4","port":1,"token":"t"}""")
        assertTrue(import.consume() is PairingImport.Result.Rejected)
        assertTrue(store.machines.value.isEmpty())
        assertFalse(File(dir, PairingImport.FILE_NAME).exists())
    }
}
