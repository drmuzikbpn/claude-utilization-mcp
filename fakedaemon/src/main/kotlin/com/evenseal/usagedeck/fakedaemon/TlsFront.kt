// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.fakedaemon

import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

/**
 * Terminates TLS with [certificate] on [bind]:[requestedPort] and pipes the plaintext to a
 * loopback port. Ktor's CIO engine cannot serve HTTPS itself, and this needs nothing beyond the
 * JDK's sockets, so the fake behaves the same on a desktop JVM and inside an Android process.
 */
internal class TlsFront(
    certificate: HeldCertificate,
    private val bind: String,
    private val requestedPort: Int,
    private val backendPort: Int
) {
    private val factory =
        HandshakeCertificates.Builder().heldCertificate(certificate).build().sslContext().serverSocketFactory
    private var server: ServerSocket? = null
    private val open = CopyOnWriteArrayList<Socket>()

    val port: Int get() = server?.localPort ?: requestedPort

    fun start() {
        val listening = factory.createServerSocket(requestedPort, BACKLOG, InetAddress.getByName(bind))
        server = listening
        thread(isDaemon = true, name = "fakedaemon-tls-accept") {
            while (!listening.isClosed) {
                val client = runCatching { listening.accept() }.getOrNull() ?: break
                runCatching { serve(client) }.onFailure { runCatching { client.close() } }
            }
        }
    }

    fun stop() {
        runCatching { server?.close() }
        server = null
        open.forEach { runCatching { it.close() } }
        open.clear()
    }

    private fun serve(client: Socket) {
        val backend = Socket(InetAddress.getByName(FakeDaemon.LOOPBACK), backendPort)
        open += client
        open += backend
        pump(client, backend, "in")
        pump(backend, client, "out")
    }

    /** Copies one direction until either side closes, then closes both. */
    private fun pump(from: Socket, to: Socket, direction: String) {
        thread(isDaemon = true, name = "fakedaemon-tls-$direction") {
            runCatching { copy(from.getInputStream(), to.getOutputStream()) }
            runCatching { from.close() }
            runCatching { to.close() }
            open -= from
            open -= to
        }
    }

    private fun copy(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(BUFFER_BYTES)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return
            output.write(buffer, 0, read)
            output.flush()
        }
    }

    private companion object {
        const val BACKLOG = 16
        const val BUFFER_BYTES = 16 * 1024
    }
}
