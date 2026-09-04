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

/**
 * An agent PROJECT on this machine, whether or not it is running.
 *
 * Deliberately thin. A fleet view needs to name it, launch it and open its
 * source; everything else about an agent lives in its own config, and copying
 * fields out of there would be a second description free to disagree with the
 * first.
 */
/** One source file that defines an agent, as an editor link. */
export type DefinitionFile = {
    /** What to call it in a list — "Configuration", "Boot", "Tools". */
    label: string
    /** Absolute path. Only ever set for a file that exists. */
    path: string
}

export type InstalledAgent = {
    /** Directory name on disk. */
    name: string
    /** The scoped name it declares — `@axon/zeno`. Falls back to `name`. */
    ref: string
    /** Which profile owns it — the same agent name can exist under two accounts. */
    profile: string
    /** Absolute path to the project. What an editor is pointed at. */
    root: string
    /** Epoch ms of last use, from its session store. Null when unreadable. */
    usedAt: number | null
    /** Declared version from package.json. Null when it declares none. */
    version: string | null
    /** Source files that exist — never a conventional path that does not. */
    definition: DefinitionFile[]
}

/** What `agents.state()` reports in one read. */
export type AgentsState = {
    /** Every live agent this daemon can see, newest first. */
    agents: AgentRecord[]
    /** Directories scanned. Diagnostics — "why is my agent missing" is otherwise unanswerable. */
    roots: readonly string[]
    /** Every agent project on this machine, running or not. */
    installed: InstalledAgent[]
}
