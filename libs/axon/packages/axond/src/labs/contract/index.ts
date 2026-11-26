import type { body } from "@arcforge/types"

type Pace = body.Pace

/**
 * Every lab implementation registered in this daemon build: Terraverse, for now.
 * Minecraft and Terraria stay in the tree (`labs/minecraft`, `labs/terraria`),
 * unregistered; adding one back is one entry here and one in `Labs`.
 *
 * The LIST is the source of truth and the union is derived from it, so a
 * surface that has to cover every lab — the daemon client, Fleet's tree — can
 * iterate rather than repeat itself, and adding a lab stays one entry. Closed
 * as a type because the daemon ships the implementations; open as a value
 * because everything above it is generic over them.
 */
export const LAB_IDS = ["terraverse"] as const

export type LabId = (typeof LAB_IDS)[number]

/** Every lab implemented in the tree, registered or not: what a lab's state may call itself. */
export type LabKind = LabId | "minecraft" | "terraria"

/** Debugger interventions are addressed to one running world, never an agent cable. */
export type TerrariaAction =
    | { kind: "teleport"; world: string; player: string; x: number; y: number }
    | { kind: "health"; world: string; player: string; value: number }
    | { kind: "spawn"; world: string; entity: "zombie" | "demon-eye" | "slime"; x: number; y: number }
export type MinecraftAction =
    | { kind: "world.time"; world: string; value: number }
    | { kind: "world.weather"; world: string; value: "clear" | "rain" | "thunder" }
    | { kind: "world.difficulty"; world: string; value: "peaceful" | "easy" | "normal" | "hard" }
    | { kind: "player.teleport"; world: string; player: string; x: number; y: number; z: number }
    | { kind: "player.gamemode"; world: string; player: string; value: "survival" | "creative" | "adventure" | "spectator" }
/** Terraverse has none yet; the unregistered labs' are kept with them. */
export type LabAction = TerrariaAction | MinecraftAction
export type MinecraftPlayer = { name: string; x: number; y: number; z: number; health: number; food: number; gamemode: "survival" | "creative" | "adventure" | "spectator" }
/** A named, server-coordinate landmark in a managed Minecraft world. */
export type MinecraftPlace = { id: string; name: string; x: number; y: number; z: number; createdAt: string }
export type LabActionResult = { at: number; world: string; action: LabAction; result: string }
export type LabIntervention = { id: string; at: number; action: LabAction; status: "requested" | "succeeded" | "failed"; detail?: string }

/** A persistent world available from a lab. A save may be a file or a directory. */
export type WorldInfo = {
    name: string
    path: string
    modifiedAt: string
    /** Lab-managed save, or a personal save offered for import. */
    source?: "lab" | "minecraft" | "prism"
    /** Present when the engine has one meaningful save-file size. */
    bytes?: number
}

/** Something the world saw happen during a scenario run, on the wall clock (`at`, ms) and the game's (`tick`). */
export type ScenarioEvent = { kind: "began" | "died" | "ended"; at: number; tick: number; detail: string }

/** A scenario as the server running it reports it. */
export type ScenarioProgress = {
    scenario: string
    phase: "waiting" | "running" | "ended"
    seconds: number
    subject?: string
    events: ScenarioEvent[]
}

/**
 * One agent put through one scenario, on a copy of its world: the record a run leaves.
 *
 * `session` is the agent's own session — where everything it sensed and did is recorded, under `agentRoot`.
 * `events` is the world's side: when the scenario began, what happened to the body, how it ended.
 */
export type ScenarioRun = {
    id: string
    world: string
    scenario: string
    /** The agent as it was asked for: a path, a name, `@scope/name`. */
    agent: string
    phase: "preparing" | "starting" | "embodying" | "running" | "ended" | "failed" | "cancelled"
    /** How the scenario ended, once it has: `timeout`, `left`. */
    outcome: string | null
    session: string | null
    agentRoot: string | null
    /** The body's player name in the world — the warm body's own (`body-2`), not the agent's identity. */
    subject: string | null
    events: ScenarioEvent[]
    /** What the lab did, in order — the run's own progress. */
    steps: Array<{ at: string; text: string }>
    failure: string | null
    /** The world as the run left it. */
    copy: string
    createdAt: string
    endedAt: string | null
}

/** Where the authoring client's window lives: on the person's own desktop, or streamed into Fleet. */
export type StudioPlace = "desktop" | "fleet"
/** An open authoring client; Fleet's frame needs the stream's address. */
export type StudioOpened = { on: "desktop" } | { on: "fleet"; url: string }

/** The lab's currently running world host. */
export type RunningWorld = {
    name: string
    path: string
    state: "starting" | "running" | "stopping"
    /** The host humans and managed bodies connect to. */
    host: string
    port: number
    password: string
    /** Everyone connected — bodies and people alike, by their in-world identity. */
    players: string[]
    pid: number | null
    startedAt: string
    /**
     * How a person may watch the world as it is — never the mind: these are
     * the lab's, never handed to an agent and never sensed. Empty for a lab
     * that offers none yet; an empty list is explicit.
     */
    observers: Observer[]
}

/**
 * One way to watch a running world, the lab's own scene camera rather than
 * a body's eye.
 *
 *   geometry   the world itself, streamed — every drawn thing and where it
 *              is, as the world contract's view says it (`world.ViewScene`)
 *              — for the viewer to draw from wherever it likes: free, behind
 *              a body, through its eye. Costs the world nothing to look.
 *
 * The next kind is `video`: frames a lab renders from a camera it places —
 * fixed, or following a body — for a lab that cannot hand over its geometry
 * (Minecraft's spectator client). Recorded, observers go beside the truth,
 * never among a mind's stimuli.
 */
export type Observer = { id: string; kind: "geometry"; label: string; url: string }

/**
 * A body's lifecycle.
 *
 * A warm game client is `booting` to the menu, `ready` there with nobody
 * inside, `joining`, then `embodied` in the world under a lease; `failed`
 * carries why, and the pool replaces it. A body a lab places in its world (Terraverse) is
 * `ready` in the world until a mind wears it, then `embodied`.
 */
export type BodyState = "booting" | "ready" | "joining" | "embodied" | "leaving" | "failed" | "stopped"

export type BodyInfo = {
    id: string
    /** Which of the lab's running worlds this body is in; null for a warm client that is in none yet. */
    world: string | null
    state: BodyState
    /** Which of the lab's bodies it is — `go2` — for a lab with more than one; null for a lab whose bodies are all one kind. */
    model: string | null
    /** The body's engine bridge an agent connects to. */
    bridge: string
    /** The game client behind the body, for a lab whose bodies are clients; null for a body a lab places in its world. */
    client: BodyClient | null
    /** Identity currently loaded into this body, or null while warm. */
    identity: string | null
    lease: string | null
    agent: string | null
    error: string | null
    /**
     * The processes this body runs — display, client, captures — the roots of
     * what it costs the machine. In the state, not behind a verb, so whoever
     * reads the lab over the socket can account for a body as exactly as the
     * daemon that runs it.
     */
    pids: number[]
    startedAt: string
    /** Debugger-only camera mapping, when this engine reports one. */
    camera?: { at: number; x: number; y: number; width: number; height: number }
}

/** A game client a body is: where it renders, sounds, and whether it is frozen. */
export type BodyClient = {
    /** The virtual display the client renders to. */
    display: string
    /** The screen's pixels, a file in shared memory: an X window dump the display keeps current. */
    screen: string
    /** Where captured stereo audio lands, newest last. */
    audio: string
    /** Frozen while unleased: warm, but costing nothing. */
    resting: boolean
}

/**
 * What an agent asks a lab for: a body, in a world, as whom, for which process.
 *
 * `world` names which of the lab's worlds to be in — started if it is not
 * running. Absent, the lab's already-running world is used, and a lab running
 * none refuses: an address that names no world cannot start one.
 *
 * `body` names which of the lab's bodies, for a lab that has more than one; a
 * lab of one kind refuses it. `scenario` makes this a run rather than an
 * open-ended connection; a lab with no scenarios refuses it.
 */
export type LeaseInput = { agent: string; pid: number; identity: string; stateDir: string; world?: string; scenario?: string; body?: string }

/** An agent's claim on a body, held for as long as the agent's process lives. */
export type Lease = {
    id: string
    body: string
    /** The world the body is in — a lab may run several beside each other. */
    world: string
    agent: string
    /** The agent's process — the lease is released when it exits. */
    pid: number
    identity: string
    /** Agent-owned durable state for this embodiment. */
    stateDir: string
    at: string
}

/**
 * What an agent is handed: which body, in which world, as whom — and where it
 * speaks the body contract (axon.body/1). Connect there with the token, and
 * the body describes itself, senses and takes commands, screen and sound
 * included. Everything a body is comes over that socket, not from here.
 */
/** A leased body, as the body contract has a lab answer: the daemon's `Lease` is its own record of one. */
export type Embodiment = body.Lease

export type BridgeState = {
    /** The engine-specific bridge every managed body loads. */
    name: string
    /** The bridge source folder. */
    source: string | null
    /** The newest bridge artifact the engine produced. */
    built: { path: string; at: string } | null
    /** The bridge artifact loaded by the running world and bodies. */
    staged: { at: string } | null
    /** The source changed after the build, or the build after what is loaded. */
    stale: boolean
}

/** A problem the lab recovered from, kept for the world's overview. */
export type Notice = { at: string; text: string }

export type LabState = {
    /** Stable routing key across daemon, Fleet and agent modules. */
    id: LabKind
    /** Human-facing environment name. */
    title: string
    /** Interventions this lab's running bridge supports. An empty list is explicit. */
    controls: Array<LabAction["kind"]>
    /** Why a running lab's debugger control is unavailable, if it is. */
    controlProblem: string | null
    /** Server-observed Minecraft conditions; absent for other labs or before control is ready. */
    conditions?: { time: number; weather: "clear" | "rain" | "thunder"; difficulty: "peaceful" | "easy" | "normal" | "hard" }
    /** Server-observed player state, distinct from the reusable body pool. */
    players?: MinecraftPlayer[]
    /** Null when everything a world needs is installed; otherwise what is missing. */
    problem: string | null
    worlds: WorldInfo[]
    /**
     * The worlds running now, beside each other — a lab serves as many as it
     * is asked for, so two agents can be in two worlds of one lab at once.
     * Empty is explicit: the lab is up and serving nothing.
     */
    running: RunningWorld[]
    bodies: BodyInfo[]
    /** Why the pool stopped booting bodies — shown until a body is added by hand or the world restarts. */
    halted: string | null
    /** Problems the pool recovered from since the world started. */
    notices: Notice[]
    leases: Lease[]
    bridge: BridgeState
}

/**
 * What every lab implementation exposes.
 *
 * Hand-written, unlike most handles in this package, because it is the seam
 * between the registry and the engines: `Labs.all` is keyed by id, so the
 * compiler has to know that every lab answers the same verbs. Inferring it
 * from one engine's handle made the OTHER engine's drift invisible — a stub
 * returning `Embodiment` where the contract is `Promise<Embodiment>` typechecks
 * fine in isolation and fails only at the call site that awaits it.
 *
 * A lab that cannot do one of these throws saying so. Absent verbs are not an
 * option: a surface written against this type would then have to ask which
 * engine it is talking to, which is the thing the registry exists to avoid.
 */
export type LabT = {
    /** Everything a surface shows for this lab, in one read. */
    state(): Promise<LabState>
    /**
     * Serve one of its worlds, beside whatever else it is serving, and give
     * back the world now running. Already running: that one, unchanged —
     * asking for a world that is already up is how an agent joins it.
     */
    start(input: { name: string }): Promise<RunningWorld>
    /** Stop one world; no name stops every one of them. */
    stop(input?: { name: string }): Promise<void>
    restart(input?: { name: string }): Promise<void>
    logs(input?: { lines?: number }): { server: string[] }
    /** Execute a debugger intervention. Unsupported labs throw explicitly. */
    act(action: LabAction): Promise<LabActionResult>
    history(): Promise<LabIntervention[]>
    bridge: {
        state(): Promise<BridgeState>
        build(): Promise<BridgeState>
    }
    /**
     * The scenarios set up in a world, and the runs they produce.
     *
     * On every lab, not only the one that has them today: a surface written
     * against this type must never ask which engine it is talking to, and
     * `axon world` asking for `labs.minecraft` by name is exactly what made
     * every other lab's worlds invisible to it. A lab with no scenarios
     * throws saying so — never an empty list, which reads as "this world has
     * none" rather than "this lab cannot".
     */
    scenarios(input: { world: string }): Promise<string[]>
    runs: {
        start(input: { world: string; scenario: string; agent: string }): Promise<ScenarioRun>
        get(input: { id: string }): Promise<ScenarioRun>
        list(input: { world: string }): Promise<ScenarioRun[]>
        cancel(input: { id: string }): Promise<void>
    }
    bodies: {
        list(): BodyInfo[]
        /** One more body: a warm client booted, or — `body` naming which — one placed in the running world. */
        add(input?: { body?: string }): BodyInfo | Promise<BodyInfo>
        lease(input: LeaseInput): Promise<Embodiment>
        release(lease: string): Promise<void>
    }
    /** Daemon shutdown: everything this lab started, stopped. */
    dispose(): Promise<void>
}

export { LabsClient } from "./client"
export type { LabsClientT } from "./client"
