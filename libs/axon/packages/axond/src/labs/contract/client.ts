import type {
    BodyInfo, BridgeState, Embodiment, Imported, LabAction, LabActionResult, LabId, LabIntervention, LabState,
    LeaseInput, LibraryEntry, MinecraftPlace, RunningWorld, ScenarioRun, StudioOpened, StudioPlace,
} from "./index"
import { LAB_IDS } from "./index"

type LabsClientOpts = {
    /** One verb over the daemon socket. */
    call: (path: readonly string[], arg?: unknown) => Promise<unknown>
    /** Whether a daemon is listening — answered from the pidfile, with no connection. */
    running: () => boolean
}

/**
 * LabsClient — the labs domain, as a daemon client reaches it.
 *
 * Lives in the contract, not beside the engines: a client of the daemon must
 * never load what runs a world (and its native image codec), and this file
 * imports nothing but the contract's own types.
 */
export function LabsClient(opts: LabsClientOpts) {
    const call = opts.call

    /**
     * One lab's verbs, for any lab. The daemon's `labs` domain is a registry
     * keyed by id, so the whole surface is the id plus the shared verb set —
     * written once here rather than once per engine, which is how the two
     * copies of it drifted.
     */
    function lab(id: LabId) {
        return {
            /** Everything a surface shows for this lab, in one read. */
            state: () => call(["labs", id, "state"]) as Promise<LabState>,
            /** Serve one of its worlds, beside whatever else it serves; gives back the world now running. */
            start: (input: { name: string }) => call(["labs", id, "start"], input) as Promise<RunningWorld>,
            stop: (input?: { name: string }) => call(["labs", id, "stop"], input) as Promise<void>,
            restart: (input?: { name: string }) => call(["labs", id, "restart"], input) as Promise<void>,
            logs: (input?: { lines?: number }) => call(["labs", id, "logs"], input) as Promise<{ server: string[] }>,
            act: (action: LabAction) => call(["labs", id, "act"], action) as Promise<LabActionResult>,
            history: () => call(["labs", id, "history"]) as Promise<LabIntervention[]>,
            bridge: {
                state: () => call(["labs", id, "bridge", "state"]) as Promise<BridgeState>,
                build: () => call(["labs", id, "bridge", "build"]) as Promise<BridgeState>,
            },
            /** The scenarios set up in one of its worlds. A lab with none throws saying so. */
            scenarios: (input: { world: string }) => call(["labs", id, "scenarios"], input) as Promise<string[]>,
            /** Scenario runs: one agent through one scenario on a copy of a world, carried on by the daemon. */
            runs: {
                start: (input: { world: string; scenario: string; agent: string }) => call(["labs", id, "runs", "start"], input) as Promise<ScenarioRun>,
                get: (input: { id: string }) => call(["labs", id, "runs", "get"], input) as Promise<ScenarioRun>,
                list: (input: { world: string }) => call(["labs", id, "runs", "list"], input) as Promise<ScenarioRun[]>,
                cancel: (input: { id: string }) => call(["labs", id, "runs", "cancel"], input) as Promise<void>,
            },
            bodies: {
                list: () => call(["labs", id, "bodies", "list"]) as Promise<BodyInfo[]>,
                /** One more body: a warm client booted, or — for a lab of many bodies — the one named, placed in its world. */
                add: (input?: { body?: string }) => call(["labs", id, "bodies", "add"], input) as Promise<BodyInfo>,
                lease: (input: LeaseInput) => call(["labs", id, "bodies", "lease"], input) as Promise<Embodiment>,
                release: (lease: string) => call(["labs", id, "bodies", "release"], lease) as Promise<void>,
            },
        }
    }

    const labs = {
        terraria: lab("terraria"),
        minecraft: {
            ...lab("minecraft"),
            studio: {
                status: () => call(["labs", "minecraft", "studio", "status"]) as Promise<{ state: "stopped" | "starting" | "running" | "failed"; on: StudioPlace | null; failure: string | null }>,
                open: (input: { on: StudioPlace }) => call(["labs", "minecraft", "studio", "open"], input) as Promise<StudioOpened>,
                stop: () => call(["labs", "minecraft", "studio", "stop"]) as Promise<void>,
            },
            worlds: {
                scenarios: (input: { name: string }) => call(["labs", "minecraft", "worlds", "scenarios"], input) as Promise<string[]>,
                import: (input: { name: string; source: "minecraft" | "prism" }) => call(["labs", "minecraft", "worlds", "import"], input) as Promise<void>,
                remove: (input: { name: string }) => call(["labs", "minecraft", "worlds", "remove"], input) as Promise<string>,
                places: {
                    list: (input: { world: string }) => call(["labs", "minecraft", "worlds", "places", "list"], input) as Promise<MinecraftPlace[]>,
                    add: (input: { world: string; name: string; x: number; y: number; z: number }) => call(["labs", "minecraft", "worlds", "places", "add"], input) as Promise<MinecraftPlace>,
                    remove: (input: { world: string; id: string }) => call(["labs", "minecraft", "worlds", "places", "remove"], input) as Promise<void>,
                },
            },
            /**
             * Download and configure Fabric. Minecraft's only extra verb, and
             * it stays an extra verb rather than being forced into the shared
             * surface: tModLoader arrives through Steam, so Terraria has
             * nothing to bootstrap and a stub pretending otherwise would be a
             * lie. EULA acceptance is an explicit caller decision.
             */
            bootstrap: (input: { acceptEula: boolean; name: string; port?: number; players?: number }) =>
                call(["labs", "minecraft", "bootstrap"], input) as Promise<void>,
        },

        atrium: {
            ...lab("atrium"),
            /** The bodies and worlds Atrium has baked, and baking more from files on this machine. */
            library: {
                list: () => call(["labs", "atrium", "library", "list"]) as Promise<LibraryEntry[]>,
                import: (input: { file: string; name?: string; as?: "body" | "world"; props?: Array<{ node: string; mass?: number }>; replace?: boolean }) =>
                    call(["labs", "atrium", "library", "import"], input) as Promise<Imported>,
            },
        },

        /**
         * Every lab's state, or none when no daemon is running — the labs
         * are the daemon's, so no daemon means no lab. What a supervisor
         * outside the daemon reads to account for the body its agent is in.
         */
        states: async (): Promise<LabState[]> => {
            if (!opts.running()) return []
            return Promise.all(LAB_IDS.map(id => call(["labs", id, "state"]) as Promise<LabState>))
        },
    }

    return labs
}

export type LabsClientT = ReturnType<typeof LabsClient>
