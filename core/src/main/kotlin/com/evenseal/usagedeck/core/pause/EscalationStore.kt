package com.evenseal.usagedeck.core.pause

import java.time.Instant

/** A scheduled soft→hard escalation. Persisted so it survives process death (spec §9). */
data class Escalation(val machineId: String, val scope: String, val fireAt: Instant)

interface EscalationStore {
    fun load(): List<Escalation>

    fun save(list: List<Escalation>)
}

class InMemoryEscalationStore : EscalationStore {
    private var escalations: List<Escalation> = emptyList()

    override fun load(): List<Escalation> = escalations

    override fun save(list: List<Escalation>) {
        escalations = list.toList()
    }
}
