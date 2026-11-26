import { Receiver } from "./control/stream"
import type { AxonEngineRequest } from "@arcforge/types"
import { Agents, type AttachResult } from "@arcforge/cloud"
import { Caller, Connection, daemonPaths, Lifecycle, remoteClient, socketFetch, type RemoteClient } from "./control/index"
import type { AgentRecord, AgentsState } from "./agents/index"
import type { ModelRecord, ModelsState } from "./models/index"
import type { Download } from "./models/downloads"
import type { Actor, Job, JobsState } from "./jobs/index"
import type { Admission, MachineState } from "./machine/index"
import type { MachineEntry, NetState } from "./net/index"
import type { DaemonPaths, DaemonStatus } from "../types/index"
// The lab contract, not the labs: a client of the daemon must never load what runs a world (and its native image codec).
import { LabsClient } from "./labs/contract/index"
import type { AgentSchedule, CreateSchedule, ScheduleState, UpdateSchedule, ScheduleResult } from "./schedule/schedule"
import type { DictationState, Dictated } from "./dictation/dictation"

export type AxonDaemonOpts = {
    /** Override where the socket lives. Tests point this at a scratch dir. */
    root?: string
    /**
     * Bring a current daemon up — see Connection. Every host that may be the
     * first to need the daemon supplies one, so the first request starts it.
     */
    launch?: () => Promise<void>
}

/**
 * AxonDaemon — the client handle every consumer holds.
 *
 * Mirrors `Axond()`'s four domains, verb for verb, over the socket. That
 * symmetry is the point: the daemon can be exercised in-process by
 * constructing `Axond()` directly, so domain tests need no transport, and the
 * transport is tested once rather than in every domain's suite.
 *
 * ── Construction connects to nothing ────────────────────────────────────────
 *
 * A handle is built whether or not a daemon is running, and a verb that needs
 * one fails with DAEMON_NOT_RUNNING naming the fix. Connecting eagerly would
 * make every consumer's startup depend on a daemon they may not need — the
 * same rule `AxonCloud()` follows for a missing key.
 *
 * ── The handle IS the SDK ───────────────────────────────────────────────────
 *
 * `agents.at(id)` returns an instance handle rather than a record, so talking
 * to an agent is `agent.say(…)` rather than `daemon.request(id, …)`. A future
 * SDK is this surface with documentation; the flat shape would have needed a
 * translation layer.
 */
export function AxonDaemon(opts: AxonDaemonOpts = {}) {
    const paths: DaemonPaths = daemonPaths(opts.root)
    const connection = Connection({ ...(opts.launch !== undefined ? { launch: opts.launch } : {}) })
    const caller = Caller({ paths: paths })
    const call: typeof caller = (path, arg) => connection.through(() => caller(path, arg))
    const receiver = Receiver({ socket: paths.socket })
    const streamed = <T>(open: () => AsyncIterable<T>) => gated(connection.ensure, open)
    /**
     * Whether a daemon is listening, answered WITHOUT one.
     *
     * Every other verb needs the socket; this one reads the pidfile, because
     * "is it running" is exactly the question a caller has when the answer is
     * no. A status that could only be obtained from a live daemon would be
     * unable to report the state it exists to report.
     *
     * The version reported is the DAEMON'S, read over the socket when one is
     * listening and absent otherwise — which is the honest answer either way.
     * It was this package's own, inlined from package.json, and that import
     * did not survive bundling into the extension host: the field rendered
     * empty in a panel that was otherwise correct. A value that depends on a
     * bundler's JSON handling is not a value to build a status line on.
     */
    const lifecycle = Lifecycle({ paths: paths, version: "", entrypoint: "" })
    const socketed = socketFetch({ paths: paths })
    const tunnel = (async (input: string | URL | Request, init?: RequestInit) => {
        await connection.ensure()
        return socketed(input, init)
    }) as typeof fetch

    /**
     * One other machine: its remote verbs, plus attaching to an agent on it.
     *
     * Attach is the cloud client's own — the same one that attaches to a
     * deployed agent — given a `fetch` that reaches the agent through this
     * daemon and the network. One protocol, whichever way an agent is reached.
     */
    function remote(key: string): RemoteClient & { attach(session: string): Promise<AttachResult> } {
        const verbs = remoteClient(async (path, arg) => {
            const answer = await call(["machines", "request"], { key: key, path: path, arg: arg }) as { value: unknown }
            return answer.value
        })
        return {
            ...verbs,
            attach: session => Agents({ fetch: tunnel }).attach(`http://axond/machines/${key}/agents/${encodeURIComponent(session)}`),
        }
    }

    const labs = LabsClient({ call: call, running: () => lifecycle.status().running })

    return {
        paths: paths,

        /**
         * Is a daemon running, and what is it. Needs no connection.
         *
         * The pidfile answers liveness, which is the half that must work with
         * nothing listening. The VERSION comes from the daemon itself through
         * `version()` — a client cannot know what the running one was built
         * from, and guessing its own would be wrong the moment they differ.
         */
        status: (): DaemonStatus => lifecycle.status(),

        /** The running daemon's own version, over the socket. */
        version: () => call(["version"]) as Promise<string>,

        /**
         * Bring the daemon up now, without waiting for a verb to need it.
         *
         * Every verb already does this on its first request, so a host calls
         * it only to warm up — Fleet at activation, so its first panel is not
         * the one that pays for the start. Rejects when the start failed;
         * a host with no `launch` resolves at once and its verbs say why.
         */
        ensure: (): Promise<void> => connection.ensure(),

        machine: {
            /** Everything the machine reports: identity, capacity, usage, holds, history. */
            state: () => call(["machine", "state"]) as Promise<MachineState>,
            /**
             * Say that this client is drawing the readings, for the next `ms`.
             *
             * Renewed every tick by a watcher. See Machine.watching on why a
             * lease and not the in-process ref-count.
             */
            watching: (ms: number) => call(["machine", "watching"], ms) as Promise<boolean>,
            /** Would `bytes` fit right now? Refuses with the holders named. */
            admit: (bytes: number) => call(["machine", "admit"], bytes) as Promise<Admission>,
        },
        agents: {
            /** Every agent running on this machine, newest first. */
            list: () => call(["agents", "list"]) as Promise<AgentRecord[]>,
            /** Everything the domain reports: the agents, and the roots scanned. */
            state: () => call(["agents", "state"]) as Promise<AgentsState>,
            /** Every agent project on this machine, running or not. */
            installed: () => call(["agents", "installed"]) as Promise<unknown[]>,
            /** Stop one agent. False when nothing by that id was running. */
            stop: (sessionId: string) => call(["agents", "stop"], sessionId) as Promise<boolean>,
        },
        jobs: {
            /** Every job on this machine, newest first, plus where they live. */
            state: () => call(["jobs", "state"]) as Promise<JobsState>,
            /** Only what still wants something to happen. */
            open: () => call(["jobs", "open"]) as Promise<Job[]>,
            /** One job by ref or full id. Null when nothing matches. */
            at: (ref: string) => call(["jobs", "at"], ref) as Promise<Job | null>,
            /** Delegate work. `by` is the actor — see Actor on what makes a human mark real. */
            create: (input: { brief: string; by: Actor; title?: string; agent?: string | null; cwd?: string | null }) =>
                call(["jobs", "create"], input) as Promise<Job>,
            /** Add a turn. A person's turn on a blocked job unblocks it. */
            say: (input: { ref: string; text: string; by: Actor }) => call(["jobs", "say"], input) as Promise<Job>,
            /** Mark it dealt with. Refused for an agent actor. */
            acknowledge: (input: { ref: string; by: Actor }) => call(["jobs", "acknowledge"], input) as Promise<Job>,
            /** Stop it. Refused for an agent actor. */
            cancel: (input: { ref: string; by: Actor }) => call(["jobs", "cancel"], input) as Promise<Job>,
            /** Run it again on the same thread. Refused for an agent actor. */
            retry: (input: { ref: string; by: Actor }) => call(["jobs", "retry"], input) as Promise<Job>,
        },
        /** Who is signed in on this machine. */
        identity: {
            read: () => call(["identity", "read"]) as Promise<{ signedIn: boolean; email: string | null }>,
        },

        /** This machine on the network: up with its key and addresses, or down with why. */
        net: {
            status: () => call(["net", "status"]) as Promise<NetState>,
            /** Try to join now rather than at the next heartbeat — after a login, say. */
            join: () => call(["net", "join"]) as Promise<void>,
        },

        /** The other machines on this account's network. */
        machines: {
            list: () => call(["machines", "list"]) as Promise<MachineEntry[]>,
            /** Another machine, through this daemon: its remote verbs, and its agents to attach to. */
            at: (key: string) => remote(key),
        },

        /** The daemon's named preferences — switches, and choices with more than two values. */
        preferences: {
            /** Every preference currently set. */
            all: () => call(["preferences", "all"]) as Promise<Record<string, unknown>>,
            /** Declare one. Strings as well as switches — see Preferences.text(). */
            set: (input: { key: string; value: boolean | string }) =>
                call(["preferences", "set"], input) as Promise<boolean | string>,
        },

        models: {
            protocol: () => call(["models", "protocol"]) as Promise<number>,
            /** Everything the domain reports: what is cached, what is resident, where the cache lives. */
            state: () => call(["models", "state"]) as Promise<ModelsState>,
            inspect: (model: string) => call(["models", "inspect"], model) as Promise<void>,
            /** Re-read what is on disk. */
            refresh: () => call(["models", "refresh"]) as Promise<ModelRecord[]>,
            /** The daemon-owned local execution environments, separate from model weights. */
            runtimes: () => call(["models", "runtimes"]) as Promise<import("./models/runtimes").RuntimeState[]>,
            installRuntime: (runtime: "onnx" | "llama.cpp" | "transformers") =>
                call(["models", "installRuntime"], runtime) as Promise<import("./models/runtimes").RuntimeState>,
            removeRuntime: (runtime: "onnx" | "llama.cpp" | "transformers") =>
                call(["models", "removeRuntime"], runtime) as Promise<boolean>,
            stream: (model: string, request: AxonEngineRequest) => streamed(() => receiver.stream({ model: model, request: { ...request, signal: undefined } }, request.signal)),
            /** Local generation models this daemon can serve right now. */
            local: () => call(["models", "local"]) as Promise<import("@arcforge/types").EngineCapability[]>,
            /** Load a weight into memory and take a hold on it. */
            load: (input: { path: string; model: string; agent: string; role: string }) =>
                call(["models", "load"], input) as Promise<ModelRecord>,
            /** Load a cached weight because a person asked. See models.pin. */
            pin: (model: string) => call(["models", "pin"], model) as Promise<ModelRecord>,
            /** Unload it and release the hold. False when it was not loaded. */
            unload: (model: string) => call(["models", "unload"], model) as Promise<boolean>,
            /**
             * Run one inference against a weight that is already resident.
             *
             * `unknown` in and out, exactly as the adapter contract has it: a
             * transcript, a vector and a completion are different shapes, and
             * a client that typed this would be inventing a taxonomy the
             * daemon deliberately does not have.
             */
            run: (input: { model: string; input: unknown }) =>
                call(["models", "run"], input) as Promise<unknown>,
            /**
             * Delete a cached weight from disk.
             *
             * Has to reach the DAEMON rather than acting locally: removal
             * unloads first, and the holds live in the daemon's memory. A
             * local delete frees bytes a daemon process still has mapped.
             */
            remove: (model: string) => call(["models", "remove"], model) as Promise<boolean>,
            /**
             * Download a weight to this machine.
             *
             * `file` names the weight inside the repository; omitted takes the
             * conventional one, and a repository with no single weight is
             * refused rather than half-fetched.
             */
            fetch: (specifier: string, file?: string) =>
                call(["models", "fetch"], { specifier: specifier, file: file }) as Promise<ModelRecord>,
            /** One repository in full — metadata, weight files, and its card. What a detail buffer renders. */
            at: (specifier: string) =>
                call(["models", "at"], specifier) as Promise<
                    ModelRecord & { weights: string[]; sizes: Record<string, number>; readme: string | null }
                >,
            /**
             * Begin a fetch and return its id, without waiting for it.
             *
             * The verb a SURFACE wants. `fetch` blocks until the bytes land,
             * which is right for `prepare` and wrong for a person clicking a
             * button — and, over this client, it puts the transfer inside the
             * daemon rather than inside whichever short-lived process asked,
             * so closing the panel no longer kills it.
             */
            download: (specifier: string, file?: string) =>
                call(["models", "download"], { specifier: specifier, file: file }) as Promise<{ id: string }>,
            /** Every transfer the daemon is running, newest first. */
            downloads: () => call(["models", "downloads"]) as Promise<Download[]>,
            /** Stop reporting a transfer. */
            cancelDownload: (id: string) => call(["models", "cancelDownload"], id) as Promise<boolean>,
            /** Forget a finished transfer. */
            dismissDownload: (id: string) => call(["models", "dismissDownload"], id) as Promise<boolean>,

            /** Search what can be downloaded. Cache-first — see Catalog. */
            search: (query: string | Record<string, unknown>) =>
                call(["models", "search"], query) as Promise<ModelRecord[]>,
            /** The next page of a search. Same input shape as `search`. */
            more: (input: string | Record<string, unknown>) =>
                call(["models", "more"], input) as Promise<ModelRecord[]>,
            /** Whether another page exists for that search. */
            hasMore: (input: string | Record<string, unknown>) =>
                call(["models", "hasMore"], input) as Promise<boolean>,
            /** Search, bypassing the cache. */
            searchFresh: (query: string) => call(["models", "searchFresh"], query) as Promise<ModelRecord[]>,
        },
        schedule: {
            state: () => call(["schedule", "state"]) as Promise<ScheduleState>,
            list: (agent?: string) => call(["schedule", "list"], agent) as Promise<AgentSchedule[]>,
            create: (input: CreateSchedule) => call(["schedule", "create"], input) as Promise<AgentSchedule>,
            update: (id: string, patch: UpdateSchedule) => call(["schedule", "update"], { id, patch }) as Promise<AgentSchedule>,
            remove: (id: string) => call(["schedule", "remove"], id) as Promise<boolean>,
            pause: (id: string) => call(["schedule", "pause"], id) as Promise<AgentSchedule>,
            resume: (id: string) => call(["schedule", "resume"], id) as Promise<AgentSchedule>,
            runNow: (id: string) => call(["schedule", "runNow"], id) as Promise<ScheduleResult>,
        },

        /**
         * Speak, and the words are typed where the cursor is.
         *
         * Every verb reaches the DAEMON rather than acting locally, because
         * the microphone stays open across two independent keypresses: the
         * process that starts a recording has exited long before the one that
         * stops it runs.
         */
        dictation: {
            state: () => call(["dictation", "state"]) as Promise<DictationState>,
            /** Open the microphone. Refuses if anything needed is missing. */
            start: () => call(["dictation", "start"]) as Promise<DictationState>,
            /** Close it, transcribe, and type the result. */
            stop: () => call(["dictation", "stop"]) as Promise<Dictated>,
            /** Start or stop — what one keybind runs in toggle mode. */
            toggle: () => call(["dictation", "toggle"]) as Promise<{ recording: boolean; dictated: Dictated | null }>,
            /** Throw away the current recording without transcribing it. */
            cancel: () => call(["dictation", "cancel"]) as Promise<void>,
            /** Register the stored chord with the compositor. Idempotent. */
            bind: () => call(["dictation", "bind"]) as Promise<{ chord: string; mode: string; bound: boolean }>,
            /** Remove it. */
            unbind: () => call(["dictation", "unbind"]) as Promise<void>,
        },

        labs: labs,
    }
}

export type AxonDaemonT = ReturnType<typeof AxonDaemon>

/** A stream that opens only once the daemon is up. Not retried: a stream is not idempotent. */
async function* gated<T>(ensure: () => Promise<void>, open: () => AsyncIterable<T>): AsyncGenerator<T> {
    await ensure()
    yield* open()
}
