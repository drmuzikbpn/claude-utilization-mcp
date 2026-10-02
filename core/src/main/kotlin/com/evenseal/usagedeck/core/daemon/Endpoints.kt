package com.evenseal.usagedeck.core.daemon

import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

/**
 * Whether [e] proves the request never reached a daemon: the name did not resolve, the connect
 * failed or timed out, or TLS (including the pin) refused the server before a byte of the request
 * was written. Anything else — a reset, a read timeout, a truncated reply — is ambiguous: the
 * daemon may have acted on it, so a non-idempotent request must not be sent again elsewhere.
 */
fun neverSent(e: IOException): Boolean = e is ConnectException ||
    e is UnknownHostException ||
    e is NoRouteToHostException ||
    e is SSLHandshakeException ||
    PinnedTls.isPinMismatch(e) ||
    (e is SocketTimeoutException && e.message.orEmpty().contains("connect", ignoreCase = true))

/**
 * The candidate addresses for one daemon, with a memory of which one answered last.
 *
 * A v2 pairing hands over every address the daemon listens on (LAN IP, `<host>.local`, tailnet
 * IP), all presenting the same pinned certificate. Requests try the address that worked last
 * first and then the rest in order, so a Mac that leaves the LAN for the tailnet is found again
 * without re-pairing. A v1 pairing has exactly one address and behaves as it always has.
 */
class Endpoints(addrs: List<String>) {
    private val addrs: List<String> = addrs.distinct().also { require(it.isNotEmpty()) { "no addresses" } }

    @Volatile
    private var preferred: String = this.addrs.first()

    /** Candidates in the order to try them now. */
    fun ordered(): List<String> {
        val first = preferred
        return listOf(first) + addrs.filter { it != first }
    }

    /** The address to dial for a single connection (the SSE stream). */
    fun current(): String = preferred

    @Synchronized
    fun succeeded(addr: String) {
        if (addr in addrs) preferred = addr
    }

    /** [addr] failed to connect: if it was the preferred one, the next connection tries the following one. */
    @Synchronized
    fun failed(addr: String) {
        if (addr != preferred) return
        preferred = addrs[(addrs.indexOf(addr) + 1) % addrs.size]
    }

    /**
     * Runs [attempt] against each candidate in turn, moving on only for transport failures that
     * [retryable] accepts. A [DaemonException] — a daemon that answered with an error — is final.
     * When every candidate fails the error is `pinning` if each one presented the wrong
     * certificate, otherwise `network`.
     */
    inline fun <T> first(retryable: (IOException) -> Boolean = { true }, attempt: (String) -> T): T {
        var last: IOException? = null
        var allPinning = true
        for (addr in ordered()) {
            try {
                return attempt(addr).also { succeeded(addr) }
            } catch (e: IOException) {
                last = e
                if (!PinnedTls.isPinMismatch(e)) allPinning = false
                if (!retryable(e)) break
            }
        }
        if (last != null && allPinning) throw DaemonException("pinning", 0, null, null)
        throw DaemonException("network", 0, last?.message, null)
    }
}
