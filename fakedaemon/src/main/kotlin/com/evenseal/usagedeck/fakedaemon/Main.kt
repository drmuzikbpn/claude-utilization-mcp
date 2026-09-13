package com.evenseal.usagedeck.fakedaemon

/** `--port 47299 --scenario warnCrossing --token fake-token`. */
data class Args(
    val port: Int = DEFAULT_PORT,
    val scenario: Scenario = Scenarios.idle,
    val token: String = DEFAULT_TOKEN
) {
    companion object {
        const val DEFAULT_PORT = 47299
        const val DEFAULT_TOKEN = "fake-token"

        fun parse(args: Array<String>): Args {
            var parsed = Args()
            var i = 0
            while (i < args.size - 1) {
                when (args[i]) {
                    "--port" -> args[i + 1].toIntOrNull()?.let { parsed = parsed.copy(port = it) }
                    "--scenario" -> parsed = parsed.copy(scenario = Scenarios.byName(args[i + 1]))
                    "--token" -> parsed = parsed.copy(token = args[i + 1])
                    else -> i--
                }
                i += 2
            }
            return parsed
        }
    }
}

private const val TICK_MS = 2_000L

fun main(args: Array<String>) {
    val parsed = Args.parse(args)
    val daemon = FakeDaemon(port = parsed.port, token = parsed.token, scenario = parsed.scenario)
    daemon.start()
    println("fakedaemon on http://0.0.0.0:${parsed.port} scenario=${parsed.scenario.name} token=${parsed.token}")
    Runtime.getRuntime().addShutdownHook(Thread { daemon.stop() })
    while (true) {
        Thread.sleep(TICK_MS)
        daemon.tick()
    }
}
