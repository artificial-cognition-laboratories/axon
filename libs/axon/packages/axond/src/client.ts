import { request as httpRequest } from "node:http"
import { err } from "@arcforge/err"
import { daemonPaths, Lifecycle } from "./control/index"
import type { AgentRecord, AgentsState } from "./agents/index"
import type { ModelRecord, ModelsState } from "./models/index"
import type { Admission, MachineState } from "./machine/index"
import type { DaemonPaths, DaemonStarted, DaemonStatus } from "../types/index"

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
            /** Would `bytes` fit right now? Refuses with the holders named. */
            admit: (bytes: number) => call(["machine", "admit"], bytes) as Promise<Admission>,
        },
        agents: {
            /** Every agent running on this machine, newest first. */
            list: () => call(["agents", "list"]) as Promise<AgentRecord[]>,
            /** Everything the domain reports: the agents, and the roots scanned. */
            state: () => call(["agents", "state"]) as Promise<AgentsState>,
            /** Stop one agent. False when nothing by that id was running. */
            stop: (sessionId: string) => call(["agents", "stop"], sessionId) as Promise<boolean>,
        },
        models: {
            /** Everything the domain reports: what is cached, what is resident, where the cache lives. */
            state: () => call(["models", "state"]) as Promise<ModelsState>,
            /** Re-read what is on disk. */
            refresh: () => call(["models", "refresh"]) as Promise<ModelRecord[]>,
            /** Load a weight into memory and take a hold on it. */
            load: (input: { path: string; model: string; agent: string; role: string }) =>
                call(["models", "load"], input) as Promise<ModelRecord>,
            /** Unload it and release the hold. False when it was not loaded. */
            unload: (model: string) => call(["models", "unload"], model) as Promise<boolean>,
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
            /** Search what can be downloaded. Cache-first — see Catalog. */
            search: (query: string) => call(["models", "search"], query) as Promise<ModelRecord[]>,
            /** Search, bypassing the cache. */
            searchFresh: (query: string) => call(["models", "searchFresh"], query) as Promise<ModelRecord[]>,
        },
        schedule: {
            list: () => call(["schedule", "state"]),
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

        const body = JSON.parse(response.body) as { ok: boolean; value?: unknown; error?: string }
        if (!body.ok) {
            throw err("DAEMON_NOT_WIRED", {
                detail: `${path.join(".")} — ${body.error ?? "unknown error"}`,
                context: { verb: path.join(".") },
            })
        }
        return body.value
    }
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
