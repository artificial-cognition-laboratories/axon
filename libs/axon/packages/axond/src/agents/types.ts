import type { AxonInstance } from "@arcforge/types"

/**
 * What the agents domain answers about.
 *
 * The RECORD is `AxonInstance` from `@arcforge/types` — the shape a running
 * agent already publishes. Not redefined here: the daemon reads records the
 * platform writes today and will write them itself tomorrow, and two
 * definitions of the same file on disk is how the two halves of that move
 * would drift apart.
 */
export type { AxonInstance }

/**
 * One agent, with the machine it runs on named.
 *
 * The id is carried explicitly rather than implied by "the daemon that
 * answered". Today there is one daemon and it is always this box; that stops
 * being true the moment a second is managed from elsewhere, and a record that
 * cannot say which machine it describes is a migration rather than a field.
 *
 * Null when the machine could not be identified — see MachineIdentity, which
 * refuses to invent one.
 */
export type AgentRecord = AxonInstance & {
    machineId: string | null
}

/** What `agents.state()` reports in one read. */
export type AgentsState = {
    /** Every live agent this daemon can see, newest first. */
    agents: AgentRecord[]
    /** Directories scanned. Diagnostics — "why is my agent missing" is otherwise unanswerable. */
    roots: readonly string[]
}
