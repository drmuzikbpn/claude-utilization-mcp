package com.evenseal.usagedeck.core.model

import java.time.Instant

/**
 * One person's quota across however many machines they are logged into. Limits are per account
 * and organisation, so when the same account appears on two machines in the same org the copy
 * with the freshest `limitsFetchedAt` wins and both machine ids are listed; the same account in
 * two organisations is two quotas and stays two users.
 */
data class UserView(
    /** `accountUuid ?: emailAddress ?: machineId`, suffixed with `/organizationUuid` when known. */
    val key: String,
    val displayName: String,
    val emailAddress: String?,
    val organizationName: String?,
    val machineIds: List<String>,
    val limits: List<Limit>,
    val limitsFetchedAt: Instant?,
    /** Best health of the machines behind this user. */
    val health: Health
) {
    val fiveHour: Limit? get() = limits.firstOrNull { it.id == "session" }
    val sevenDay: Limit? get() = limits.firstOrNull { it.id == "weekly_all" }
    val scoped: List<Limit> get() = limits.filter { it.kind == "weekly_scoped" }
}

/**
 * One repo on one machine. Worktrees of the same repo roll up because the daemon keys projects
 * by `gitCommonDir`; the same repo cloned on two machines is deliberately two projects.
 */
data class ProjectView(
    val machineId: String,
    val key: String,
    val name: String,
    val sessions: List<Session>,
    val todayTokens: Tokens?,
    val worktreeCount: Int
) {
    val liveTokens: Tokens get() = sessions.fold(Tokens.ZERO) { a, s -> a + s.tokens }
    val isIdle: Boolean get() = sessions.none { it.alive }

    /** The most severe pause across the project's sessions; HARD beats SOFT. */
    val pause: PauseState? get() = sessions.mapNotNull { it.pause }.maxByOrNull { it.mode.ordinal }
}

/** The merged view of every paired machine. */
data class TeamState(val machines: List<MachineState> = emptyList()) {
    val users: List<UserView> by lazy { buildUsers() }

    /** Live projects first (by live tokens, descending), then idle ones (by today's tokens). */
    val projects: List<ProjectView> by lazy { buildProjects() }

    val liveSessionCount: Int get() = machines.sumOf { m -> m.sessions.count { it.alive } }

    val teamToday: Tokens get() = machines.fold(Tokens.ZERO) { a, m -> a + m.today }

    fun machine(id: String): MachineState? = machines.firstOrNull { it.config.id == id }

    fun session(machineId: String, sessionId: String): Session? =
        machine(machineId)?.sessions?.firstOrNull { it.sessionId == sessionId }

    private fun buildUsers(): List<UserView> = machines.groupBy { userKey(it) }.map { (key, group) ->
        val freshest = group.maxByOrNull { it.limitsFetchedAt ?: Instant.EPOCH }
        UserView(
            key = key,
            displayName = group.firstNotNullOfOrNull { displayNameOf(it) } ?: key,
            emailAddress = group.firstNotNullOfOrNull { it.user?.emailAddress },
            organizationName = group.firstNotNullOfOrNull { it.user?.organizationName },
            machineIds = group.map { it.config.id },
            limits = freshest?.limits.orEmpty(),
            limitsFetchedAt = freshest?.limitsFetchedAt,
            health = group.minOf { it.health }
        )
    }

    private fun userKey(m: MachineState): String {
        val account = m.user?.accountUuid?.takeIf { it.isNotBlank() }
            ?: m.user?.emailAddress?.takeIf { it.isNotBlank() }
            ?: m.config.id
        return m.user?.organizationUuid?.takeIf { it.isNotBlank() }?.let { "$account/$it" } ?: account
    }

    /** A bare e-mail is a poor headline; its local part reads like a name and fits the rail. */
    private fun displayNameOf(m: MachineState): String? = m.user?.displayName?.takeIf { it.isNotBlank() && '@' !in it }
        ?: m.user?.emailAddress?.substringBefore('@')
        ?: m.name
        ?: m.config.name

    private fun buildProjects(): List<ProjectView> {
        val live = mutableListOf<ProjectView>()
        val idle = mutableListOf<ProjectView>()
        machines.forEach { m ->
            // Only sessions the daemon reports alive make it onto the board; transcript back-fill of
            // finished sessions is history, and history belongs to the tokens endpoint, not the rows.
            val byKey = m.sessions.filter { it.alive }.groupBy { it.projectKey }
            val liveCwds = m.sessions.filter { it.alive }.map { it.cwd }.toSet()
            byKey.forEach { (key, sessions) ->
                val cwds = sessions.map { it.cwd }.toSet()
                val today = m.projectTokens
                    .filter { it.label in cwds }
                    .fold(Tokens.ZERO) { a, p -> a + p.tokens }
                    .takeIf { m.projectTokens.any { p -> p.label in cwds } }
                live += ProjectView(
                    machineId = m.config.id,
                    key = key,
                    name = sessions.first().projectName,
                    sessions = sessions,
                    todayTokens = today,
                    worktreeCount = sessions.map { it.worktree }.distinct().size
                )
            }
            m.projectTokens.filter { it.label !in liveCwds }.forEach { p ->
                idle += ProjectView(
                    machineId = m.config.id,
                    key = p.label,
                    name = p.label.substringAfterLast('/'),
                    sessions = emptyList(),
                    todayTokens = p.tokens,
                    worktreeCount = 0
                )
            }
        }
        val (active, quiet) = live.partition { !it.isIdle }
        return active.sortedByDescending { it.liveTokens.total } +
            (quiet + idle)
                .filter { (it.todayTokens?.total ?: 0L) > 0L }
                .sortedByDescending { it.todayTokens?.total ?: 0L }
    }
}
