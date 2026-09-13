package com.evenseal.usagedeck.core.alerts

import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.UserView
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.flow.StateFlow

enum class AlertKind { WARN, CRITICAL, FROZEN, UNREACHABLE }

/**
 * [key] is the dedupe key: `"$kind|$userKey|$limitId"`, `"$kind|$machineId"` or
 * `"$kind|$machineId|$sessionId"`.
 */
data class Alert(val kind: AlertKind, val key: String, val title: String, val body: String)

data class AlertThresholds(val warn: Int = 80, val critical: Int = 95)

/**
 * Pure diff of two merged snapshots. Quiet hours and the 10-minute critical repeat are the
 * caller's business; this only reports what has just changed.
 */
class AlertEvaluator(
    private val thresholds: StateFlow<AlertThresholds>,
    private val zone: ZoneId = ZoneId.systemDefault()
) {
    fun evaluate(prev: TeamState?, next: TeamState): List<Alert> =
        limitAlerts(prev, next) + frozenAlerts(prev, next) + unreachableAlerts(prev, next)

    private fun limitAlerts(prev: TeamState?, next: TeamState): List<Alert> {
        val t = thresholds.value
        val before = prev?.users?.associateBy { it.key }.orEmpty()
        return next.users.flatMap { user ->
            val previousLimits = before[user.key]?.limits?.associateBy { it.id }.orEmpty()
            user.limits.mapNotNull { limit ->
                val was = previousLimits[limit.id]?.percent
                when {
                    crossed(was, limit.percent, t.critical) ->
                        alert(AlertKind.CRITICAL, user, limit, "Usage critical")
                    crossed(was, limit.percent, t.warn) && limit.percent < t.critical ->
                        alert(AlertKind.WARN, user, limit, "Usage warning")
                    else -> null
                }
            }
        }
    }

    /** True when the limit has just reached [threshold], including the first time we see it. */
    private fun crossed(was: Int?, now: Int, threshold: Int): Boolean =
        now >= threshold && (was == null || was < threshold)

    private fun alert(kind: AlertKind, user: UserView, limit: Limit, title: String) = Alert(
        kind = kind,
        key = "$kind|${user.key}|${limit.id}",
        title = title,
        body = "${user.displayName} ${labelOf(limit)} at ${limit.percent}% · ${resetOf(limit)}"
    )

    private fun labelOf(limit: Limit): String = when (limit.id) {
        "session" -> "5-hour"
        "weekly_all" -> "7-day"
        else -> limit.scopeModel ?: limit.id
    }

    private fun resetOf(limit: Limit): String =
        limit.resetsAt?.let { "resets ${RESET_FORMAT.withZone(zone).format(it)}" } ?: "resets: unknown"

    private fun frozenAlerts(prev: TeamState?, next: TeamState): List<Alert> = next.machines.flatMap { machine ->
        val before = prev?.machine(machine.config.id)?.sessions?.associateBy { it.sessionId }.orEmpty()
        machine.sessions.filter { session ->
            session.pause?.mode == PauseMode.HARD && before[session.sessionId]?.pause?.mode != PauseMode.HARD
        }.map { session ->
            Alert(
                kind = AlertKind.FROZEN,
                key = "${AlertKind.FROZEN}|${machine.config.id}|${session.sessionId}",
                title = "Session frozen",
                body = "${session.projectName} on ${nameOf(machine)} is hard-frozen"
            )
        }
    }

    private fun unreachableAlerts(prev: TeamState?, next: TeamState): List<Alert> =
        next.machines.mapNotNull { machine ->
            val was = prev?.machine(machine.config.id)?.health
            if (machine.health == Health.DEAD && (was == Health.FRESH || was == Health.STALE)) {
                Alert(
                    kind = AlertKind.UNREACHABLE,
                    key = "${AlertKind.UNREACHABLE}|${machine.config.id}",
                    title = "Machine unreachable",
                    body = "${nameOf(machine)} has not checked in for 2 minutes"
                )
            } else {
                null
            }
        }

    private fun nameOf(machine: MachineState): String = machine.name ?: machine.config.name

    private companion object {
        val RESET_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE HH:mm", Locale.US)
    }
}
