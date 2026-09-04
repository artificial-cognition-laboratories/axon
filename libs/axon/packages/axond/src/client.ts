import { request as httpRequest } from "node:http"
import { err, errorMap, type AxonErrorCode } from "@arcforge/err"
import { daemonPaths, Lifecycle } from "./control/index"
import type { AgentRecord, AgentsState } from "./agents/index"
import type { ModelRecord, ModelsState } from "./models/index"
import type { Download } from "./models/downloads"
import type { Actor, Job, JobsState } from "./jobs/index"
import type { Admission, MachineState } from "./machine/index"
import type { DaemonPaths, DaemonStarted, DaemonStatus } from "../types/index"
import type { AgentSchedule, CreateSchedule, ScheduleState, UpdateSchedule, ScheduleResult } from "./schedule/schedule"
import type { DictationState, Dictated } from "./dictation/dictation"

export type AxonDaemonOpts = {
    /** Override where the socket lives. Tests point this at a scratch dir. */
    root?: string
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
    const call = Caller({ paths: paths })
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
         * Make sure a daemon is running, starting one if not.
         *
         * The verb that makes the daemon INVISIBLE. Nobody should have to know
         * it exists — a surface calls this before it needs the machine, and
         * either finds one already up (the common case, one pidfile read) or
         * starts one and waits for its socket.
         *
         * Idempotent and cheap when it is already running, which is what lets
         * every entry point call it unconditionally rather than each deciding
         * whether it is the one responsible.
         *
         * `runtime` and `entrypoint` are the caller's to supply: a host that
         * is not Bun cannot run a `.ts` daemon with its own interpreter, and
         * finding a suitable one is a question about that host rather than
         * about the daemon.
         */
        async ensure(input: { entrypoint: string; runtime?: string }): Promise<DaemonStarted> {
            return Lifecycle({
                paths: paths,
                version: "",
                entrypoint: input.entrypoint,
                ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
            }).up()
        },

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
            create: (input: { content: string; by: Actor; title?: string; agent?: string | null; cwd?: string | null }) =>
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

        /** The daemon's named preferences — switches, and choices with more than two values. */
        preferences: {
            /** Every preference currently set. */
            all: () => call(["preferences", "all"]) as Promise<Record<string, unknown>>,
            /** Declare one. Strings as well as switches — see Preferences.text(). */
            set: (input: { key: string; value: boolean | string }) =>
                call(["preferences", "set"], input) as Promise<boolean | string>,
        },

        models: {
            /** Everything the domain reports: what is cached, what is resident, where the cache lives. */
            state: () => call(["models", "state"]) as Promise<ModelsState>,
            /** Re-read what is on disk. */
            refresh: () => call(["models", "refresh"]) as Promise<ModelRecord[]>,
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
                    ModelRecord & { weights: string[]; readme: string | null }
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
    }
}

export type AxonDaemonT = ReturnType<typeof AxonDaemon>

/**
 * One request to the daemon.
 *
 * Below the factory because it serves it. A closure rather than a leaf: it
 * holds no state beyond the socket path, and a handle wrapping one fetch would
 * be a noun invented for a verb.
 */
function Caller(opts: { paths: DaemonPaths }) {
    return async function call(path: readonly string[], arg?: unknown): Promise<unknown> {
        let response: { status: number; body: string }
        try {
            response = await post(opts.paths.socket, JSON.stringify({ path: path, arg: arg }))
        } catch (cause) {
            // A refused connection is the ordinary "no daemon" case, not a
            // fault — reported as such so a caller can offer `axon daemon up`
            // rather than surfacing a socket error.
            throw err("DAEMON_NOT_RUNNING", {
                detail: `no daemon listening on ${opts.paths.socket}`,
                context: { socket: opts.paths.socket, verb: path.join(".") },
                cause,
            })
        }

        const body = JSON.parse(response.body) as {
            ok: boolean
            value?: unknown
            error?: string
            fault?: { code?: string; message?: string; context?: unknown }
        }
        if (!body.ok) throw rebuild(path, body)
        return body.value
    }
}

/**
 * Turn a failed response back into the error the domain threw.
 *
 * The daemon sends the whole AxonError, so the code survives the wire and a
 * caller sees what a local caller would. `errorMap` is keyed by NAME and the
 * error carries its CODE, so this looks the name back up — one linear scan
 * over a static map, paid only on failure.
 *
 * DAEMON_NOT_WIRED remains the fallback, and now means what it says: the
 * daemon answered with something that carries no code, which is either a
 * thrown non-Error or a daemon older than this client.
 */
function rebuild(
    path: readonly string[],
    body: { error?: string; fault?: { code?: string; message?: string; context?: unknown } },
): Error {
    const verb = path.join(".")
    const code = body.fault?.code
    if (code) {
        const name = (Object.keys(errorMap) as AxonErrorCode[])
            .find(key => errorMap[key].code === code)
        if (name) {
            return err(name, {
                detail: body.fault?.message ?? body.error ?? verb,
                context: {
                    ...(body.fault?.context && typeof body.fault.context === "object"
                        ? body.fault.context as Record<string, unknown>
                        : {}),
                    verb: verb,
                },
            })
        }
    }
    return err("DAEMON_NOT_WIRED", {
        detail: `${verb} — ${body.error ?? "unknown error"}`,
        context: { verb: verb },
    })
}

/**
 * POST one request over a unix socket.
 *
 * `node:http` rather than `fetch`, because this client runs in BOTH runtimes.
 * Bun's fetch takes a `unix` option and Node's does not — it ignores the
 * field, sends the request to `http://localhost/` over TCP, and fails. So the
 * VS Code extension host reported "no daemon listening" while a daemon was
 * running and answering perfectly on the same machine, which is exactly the
 * kind of failure a silently-ignored option produces.
 *
 * `node:http` supports unix sockets natively in both, so one code path serves
 * both hosts rather than a runtime check choosing between two.
 */
function post(socketPath: string, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                socketPath: socketPath,
                path: "/",
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
            },
            response => {
                let text = ""
                response.setEncoding("utf-8")
                response.on("data", chunk => { text += chunk })
                response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }))
            },
        )
        request.on("error", reject)
        request.end(body)
    })
}
