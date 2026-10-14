// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.MachineConfig
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

/** A `MockWebServer` serving HTTPS with a self-signed key, and the paired config that pins it. */
internal class PinnedServer {
    val server = MockWebServer()
    private val held = HeldCertificate.Builder().commonName("claude-usage").ecdsa256().build()
    val fp: String = PinnedTls.fingerprint(held.certificate)

    fun start() {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(held).build().sslSocketFactory(), false)
        server.start()
    }

    fun config(token: String = "tok") = MachineConfig("m", "n", server.hostName, server.port, token, fp = fp)
}
