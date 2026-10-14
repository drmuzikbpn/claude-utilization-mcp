// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.fakedaemon

import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

/**
 * `--port 47299 --tls-port 47300 --scenario warnCrossing [--bind 0.0.0.0] [--addrs a,b]
 * [--token …] [--link-file path]`.
 *
 * [bind] is where the HTTPS listener binds: loopback unless asked otherwise. [addrs] are the
 * addresses the pairing link advertises; the default suits the Android emulator, which reaches
 * the host's loopback as `10.0.2.2`. With no [token] a fresh one is generated for the run.
 */
data class Args(
    val port: Int = DEFAULT_PORT,
    val tlsPort: Int? = null,
    val scenario: Scenario = Scenarios.idle,
    val token: String? = null,
    val bind: String = FakeDaemon.LOOPBACK,
    val addrs: List<String> = EMULATOR_ADDRS,
    val linkFile: String? = null
) {
    companion object {
        const val DEFAULT_PORT = 47299

        /** The emulator's alias for the host, then the host itself. */
        val EMULATOR_ADDRS = listOf("10.0.2.2", FakeDaemon.LOOPBACK)

        fun parse(args: Array<String>): Args {
            var parsed = Args()
            var i = 0
            while (i < args.size - 1) {
                val value = args[i + 1]
                when (args[i]) {
                    "--port" -> value.toIntOrNull()?.let { parsed = parsed.copy(port = it) }
                    "--tls-port" -> value.toIntOrNull()?.let { parsed = parsed.copy(tlsPort = it) }
                    "--scenario" -> parsed = parsed.copy(scenario = Scenarios.byName(value))
                    "--token" -> parsed = parsed.copy(token = value)
                    "--bind" -> parsed = parsed.copy(bind = value)
                    "--addrs" -> parsed = parsed.copy(addrs = value.split(',').filter { it.isNotBlank() })
                    "--link-file" -> parsed = parsed.copy(linkFile = value)
                    else -> i--
                }
                i += 2
            }
            return parsed
        }
    }
}

private const val TICK_MS = 2_000L

/** Prints the pairing link and, when asked, also leaves it in an owner-only file for a script to push. */
private fun announce(daemon: FakeDaemon, parsed: Args) {
    val link = daemon.pairingLink(parsed.addrs)
    println("pair with (single use): $link")
    parsed.linkFile?.let { path ->
        val file = File(path)
        file.delete()
        runCatching { Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(OWNER_ONLY)) }
        file.writeText(link + "\n")
    }
}

private val OWNER_ONLY = PosixFilePermissions.fromString("rw-------")

fun main(args: Array<String>) {
    val parsed = Args.parse(args)
    val daemon = FakeDaemon(
        port = parsed.port,
        token = parsed.token ?: FakeDaemon.newSecret(TOKEN_BYTES),
        scenario = parsed.scenario,
        tlsPort = parsed.tlsPort ?: (parsed.port + 1),
        bind = parsed.bind
    )
    daemon.start()
    println(
        "fakedaemon scenario=${parsed.scenario.name}: http://${FakeDaemon.LOOPBACK}:${parsed.port} (loopback only), " +
            "https://${parsed.bind}:${daemon.tlsPort} (fp ${daemon.fingerprint})"
    )
    // A throwaway token for a throwaway process: printed so `curl` against the fake stays easy.
    println("token for this run: ${daemon.token}")
    daemon.onPaired = { announce(daemon, parsed) }
    announce(daemon, parsed)
    Runtime.getRuntime().addShutdownHook(Thread { daemon.stop() })
    while (true) {
        Thread.sleep(TICK_MS)
        daemon.tick()
    }
}

private const val TOKEN_BYTES = 32
