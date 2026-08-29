import { err } from "@arcforge/err"
import type { AxonCloudClient } from "@arcforge/cloud"
import { Boot, daemonPaths, Dispatch, Lifecycle, Server } from "./control/index"
import { Machine } from "./machine/index"
import { Agents } from "./agents/index"
import { Supervise } from "./agents/supervise"
import { Models } from "./models/index"
import { Schedule } from "./schedule/index"
import type { DaemonPaths } from "../types/index"

export type AxondOpts = {
    /** Override where the socket, pidfile and log live. Tests point this at a scratch dir. */
    root?: string
    /** This build's version — stamped into `status` and reported to clients. */
    version?: string
    /** Where resource holds are written. Tests point this at a scratch dir. */
    residencyRoot?: string
    /** Where running-agent records are written. Tests point this at a scratch dir. */
    agentsRoot?: string
    /**
     * The command a boot unit runs. Defaults to `axon daemon serve`.
     *
     * Overridable because a source checkout is not on PATH as `axon`, and a
     * unit naming a binary that does not exist fails silently at boot.
     */
    bootCommand?: string[]
    /** Where the boot unit is written. Tests point this at a scratch dir. */
    bootRoot?: string
    /** Where model weights are cached. Tests point this at a scratch dir. */
    modelsRoot?: string
    /**
     * The cloud client, for supervising agents.
     *
     * Handed in rather than built here: the credential is the user's, resolved
     * from the store by whoever logged in, and a daemon constructing its own
     * would be a second answer to "who is signed in".
     *
     * A thunk, so a caller whose client is built alongside the daemon can wire
     * both without ordering them — see SuperviseOpts.cloud.
     */
    cloud?: () => AxonCloudClient
    /**
     * Absolute path to the executable a detached start spawns.
     *
     * Supplied rather than derived: the daemon is started from a CLI, from a
     * systemd unit, and from a test, and each knows where its own binary is.
     * Deriving it from `import.meta` here would resolve to this file, which is
     * a module rather than an entrypoint.
     */
    entrypoint?: string
}

/**
 * Axond — the daemon, as a composition root.
 *
 * Server side. `AxonDaemon()` is the client handle with the same four domains;
 * see this package's CLAUDE.md for why they mirror.
 *
 * Construction touches nothing: no socket, no probe, no filesystem beyond
 * resolving paths. `serve()` is what starts it, and every domain fails at the
 * call that needs it rather than at boot — so a daemon whose GPU cannot be
 * probed still starts and still answers about agents.
 */
export function Axond(opts: AxondOpts = {}) {
    const paths: DaemonPaths = daemonPaths(opts.root)
    const version = opts.version ?? "0.0.0"

    /**
     * Makes the daemon start with the machine.
     *
     * The command is `axon daemon serve`, not this binary: a unit naming a
     * source path breaks when the published CLI is installed, and one naming a
     * versioned path breaks on every upgrade. The CLI is the stable name for
     * whatever axond currently is.
     */
    const boot = Boot({
        command: opts.bootCommand ?? ["axon", "daemon", "serve"],
        ...(opts.bootRoot !== undefined ? { root: opts.bootRoot } : {}),
    })

    const lifecycle = Lifecycle({
        paths: paths,
        version: version,
        entrypoint: opts.entrypoint ?? "",
    })

    const machine = Machine(opts.residencyRoot !== undefined ? { residencyRoot: opts.residencyRoot } : {})
    /**
     * What the daemon holds on a confined agent's behalf.
     *
     * Built only when a credential is supplied: a daemon reading the registry
     * needs none, and requiring one would make `axond agents` fail on a
     * machine nobody has logged into. `spawn` is what refuses when it is
     * absent, at the call that needs it.
     */
    const supervise = opts.cloud ? Supervise({ cloud: opts.cloud }) : undefined

    const agents = Agents({
        ...(supervise ? { supervise: supervise } : {}),
        // Identity belongs to the machine domain — the agents domain names the
        // box on each record rather than probing it a second time.
        machineId: () => machine.identity.current().id,
        ...(opts.agentsRoot !== undefined ? { root: opts.agentsRoot } : {}),
    })
    // The machine owns admission and residency: a load is a claim on video
    // memory, and the thing that owns the GPU decides whether it fits.
    const models = Models({
        machine: machine,
        ...(opts.modelsRoot !== undefined ? { root: opts.modelsRoot } : {}),
    })
    const schedule = Schedule()

    const dispatch = Dispatch({
        domains: {
            machine: machine,
            agents: agents,
            models: models,
            schedule: schedule,
            // Not a domain — one fact only the daemon can report. A client
            // reading a pidfile knows a daemon is up and cannot know what it
            // was built from.
            version: () => version,
        },
    })

    const server = Server({
        paths: paths,
        dispatch: dispatch,
    })

    return {
        paths: paths,
        version: version,

        lifecycle: lifecycle,
        server: server,
        boot: boot,

        machine: machine,
        agents: agents,
        models: models,
        schedule: schedule,

        /**
         * Become the daemon: bind the socket, claim the pidfile, and stay up.
         *
         * Refuses when one is already running rather than binding beside it —
         * two daemons would each believe they owned the GPU, which is the one
         * failure the whole design exists to prevent.
         *
         * The pidfile is claimed AFTER the socket binds, so "a pid exists"
         * always implies "a socket is accepting". Claiming first would make
         * `up` report ready to a client that then cannot connect.
         */
        async serve(): Promise<void> {
            const running = lifecycle.pid()
            if (running !== null) {
                throw err("DAEMON_ALREADY_RUNNING", {
                    detail: `pid ${running} is already listening on ${paths.socket}`,
                    context: { pid: running, socket: paths.socket },
                })
            }

            server.listen()
            lifecycle.claim()
            // Polling begins with serving, not with construction: a client
            // holding an Axond() to read paths must not start a timer.
            machine.start()
            // What is on disk, read once at start rather than per render —
            // see Models.state().
            void models.refresh()
        },

        /** Stop listening and release the pidfile. Idempotent. */
        async shutdown(): Promise<void> {
            await agents.dispose()
            await models.dispose()
            machine.stop()
            await server.close()
            lifecycle.release()
        },
    }
}

export type AxondT = ReturnType<typeof Axond>
