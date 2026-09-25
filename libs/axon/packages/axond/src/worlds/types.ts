/** A world on disk — a `.wld` in tModLoader's Worlds folder. */
export type WorldFile = {
    name: string
    path: string
    bytes: number
    modifiedAt: string
}

/** The one running dedicated server. */
export type RunningWorld = {
    name: string
    path: string
    state: "starting" | "running" | "stopping"
    /** What a person types into "Join via IP". */
    host: string
    port: number
    password: string
    /** Everyone connected — bodies and people alike, by character name. */
    players: string[]
    pid: number | null
    startedAt: string
}

/**
 * A warm game client's lifecycle.
 *
 * `ready` is at the menu with nobody inside; `embodied` is in the world under
 * a lease. `failed` carries why, and the pool replaces it.
 */
export type BodyState = "booting" | "ready" | "joining" | "embodied" | "leaving" | "failed" | "stopped"

export type BodyInfo = {
    id: string
    state: BodyState
    /** The virtual display the client renders to. */
    display: string
    /** The AxonT bridge an agent connects to. */
    bridge: string
    /** Where captured frames land, newest last. */
    frames: string
    /** Where captured stereo audio lands, newest last. */
    audio: string
    character: string | null
    lease: string | null
    agent: string | null
    error: string | null
    startedAt: string
}

/** An agent's claim on a body, held for as long as the agent's process lives. */
export type Lease = {
    id: string
    body: string
    agent: string
    /** The agent's process — the lease is released when it exits. */
    pid: number
    character: string
    /** Where the character's files live between embodiments — the agent's own folder. */
    characterDir: string
    at: string
}

/** What an agent is handed: everything it needs to occupy the body. */
export type LeaseGrant = {
    lease: string
    body: string
    world: string
    bridge: string
    frames: string
    audio: string
    character: string
}

export type ModState = {
    /** The AxonT source folder tModLoader builds from. */
    source: string | null
    /** The newest build tModLoader produced. */
    built: { path: string; at: string } | null
    /** The copy the running world and its bodies loaded. */
    staged: { at: string } | null
    /** The source changed after the build, or the build after what is loaded. */
    stale: boolean
}

/** A problem the lab recovered from, kept for the world's overview. */
export type Notice = { at: string; text: string }

export type WorldsState = {
    /** Null when everything a world needs is installed; otherwise what is missing. */
    problem: string | null
    worlds: WorldFile[]
    running: RunningWorld | null
    bodies: BodyInfo[]
    /** Why the pool stopped booting bodies — shown until a body is added by hand or the world restarts. */
    halted: string | null
    /** Problems the pool recovered from since the world started. */
    notices: Notice[]
    leases: Lease[]
    mod: ModState
}
