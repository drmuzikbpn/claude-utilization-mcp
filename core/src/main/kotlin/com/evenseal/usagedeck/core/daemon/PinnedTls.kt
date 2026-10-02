package com.evenseal.usagedeck.core.daemon

import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedTrustManager
import okhttp3.OkHttpClient

/** The daemon presented a certificate whose key is not the one this deck paired with. */
class PinMismatchException : CertificateException("certificate does not match the paired fingerprint")

/**
 * HTTPS to a daemon (§23.45). Its certificate is self-signed ECDSA P-256, so there is no chain to
 * evaluate: the server is trusted **iff** the SHA-256 of the leaf's SubjectPublicKeyInfo equals the
 * fingerprint the pairing link carried. Host names are not checked — the LAN IP, `.local` name and
 * tailnet IP all present the same key, and the pin is the whole of the identity.
 */
object PinnedTls {
    /** Lowercase hex SHA-256 of [cert]'s SubjectPublicKeyInfo DER. */
    fun fingerprint(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded).joinToString("") { "%02x".format(it) }

    /** [base] with its TLS trust replaced by the pin on [fp]. */
    fun client(base: OkHttpClient, fp: String): OkHttpClient {
        val trust = PinnedTrustManager(fp)
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return base.newBuilder()
            .sslSocketFactory(context.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .build()
    }

    /** Whether [t] (an OkHttp failure) was this pin refusing the server. */
    fun isPinMismatch(t: Throwable?): Boolean {
        var cause = t
        repeat(MAX_CAUSE_DEPTH) {
            if (cause == null) return false
            if (cause is PinMismatchException) return true
            cause.suppressed.forEach { if (isPinMismatch(it)) return true }
            cause = cause.cause
        }
        return false
    }

    private const val MAX_CAUSE_DEPTH = 8
}

/**
 * Extends [X509ExtendedTrustManager] so the JDK does not wrap it with its own endpoint and
 * algorithm checks, which would reintroduce the host-name check the pin replaces.
 */
private class PinnedTrustManager(fp: String) : X509ExtendedTrustManager() {
    private val pin = fp.lowercase().toByteArray(Charsets.US_ASCII)

    private fun check(chain: Array<out X509Certificate>?) {
        val leaf = chain?.firstOrNull() ?: throw PinMismatchException()
        val presented = PinnedTls.fingerprint(leaf).toByteArray(Charsets.US_ASCII)
        if (pin.size != HEX_SHA256_LENGTH || !MessageDigest.isEqual(presented, pin)) throw PinMismatchException()
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = check(chain)

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
        check(chain)

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
        check(chain)

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
        throw CertificateException("client certificates are not accepted")

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
        throw CertificateException("client certificates are not accepted")

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
        throw CertificateException("client certificates are not accepted")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    private companion object {
        const val HEX_SHA256_LENGTH = 64
    }
}
