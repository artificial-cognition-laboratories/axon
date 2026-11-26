import type {
    BodyInfo, BridgeState, Embodiment, LabAction, LabActionResult, LabId, LabIntervention, LabState,
    LeaseInput, RunningWorld, ScenarioRun,
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
        terraverse: lab("terraverse"),

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
