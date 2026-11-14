import { err } from "@arcforge/err"
import type { AgentsT } from "../agents/index"
import type { DictationT } from "../dictation/index"
import type { LabsT } from "../labs/index"
import type { MachineT } from "../machine/index"
import type { ModelsT } from "../models/index"
import type { NetT } from "../net/index"
import type { RemoteServerT } from "./remote/index"
import type { ScheduleT } from "../schedule/index"
import type { DaemonPaths } from "../../types/index"
import type { LifecycleT } from "./lifecycle"
import type { ServerT } from "./server"

type ServiceOpts = {
    paths: DaemonPaths
    net: NetT
    remote: RemoteServerT
    /** Whether this daemon joins the machine network at all. */
    network: boolean
    lifecycle: LifecycleT
    server: ServerT
    machine: MachineT
    schedule: ScheduleT
    models: ModelsT
    dictation: DictationT
    agents: AgentsT
    labs: LabsT
}

/**
 * Service — becoming the daemon, and ceasing to be one.
 *
 * The order things start and stop in is the content here: the socket before
 * the pidfile, agents before the labs their bodies live in, the microphone
 * before the process goes. `Axond()` wires the domains; this sequences them.
 */
export function Service(opts: ServiceOpts) {
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
    async function serve(): Promise<void> {
        const running = opts.lifecycle.pid()
        if (running !== null) {
            throw err("DAEMON_ALREADY_RUNNING", {
                detail: `pid ${running} is already listening on ${opts.paths.socket}`,
                context: { pid: running, socket: opts.paths.socket },
            })
        }

        opts.server.listen()
        opts.lifecycle.claim()
        /*
         * The network after the socket: a daemon is useful to this machine
         * before it is useful to others. A sidecar that will not start does not
         * stop the daemon — `net.status()` reports it down and why, and every
         * request to another machine fails with NET_SIDECAR_DOWN naming it.
         */
        if (opts.network) {
            // Inbound before outbound: the sidecar hands other machines' streams
            // to remote.sock, which must exist before anyone can be told we are up.
            await opts.remote.listen()
            // Never throws — a machine that cannot join yet (signed out, no
            // sidecar, backend down) keeps trying each heartbeat, and
            // `net.status()` says why it is outside.
            await opts.net.start()
        }
        // Polling begins with serving, not with construction: a client
        // holding an Axond() to read paths must not start a timer.
        opts.machine.start()
        opts.schedule.start()
        // What is on disk, read once at start rather than per render —
        // see Models.state(). Not awaited: a model store that cannot be
        // read must not keep the daemon (and every agent) from starting.
        // The inventory holds the fault and throws it to every reader, so
        // it is never seen as "no models"; this logs it once at start.
        opts.models.refresh().catch(cause => console.error(`[axond] model inventory unreadable at start: `
            + `${cause instanceof Error ? cause.message : String(cause)}`))

        /*
         * Re-register the dictation chord with the compositor.
         *
         * The binding is live rather than written into anyone's config, so
         * it does not survive a logout — and re-applying at every start is
         * exactly what makes that trade work. A daemon that starts at login
         * therefore restores the shortcut before the person reaches for it.
         *
         * Reported and not fatal: no chord bound is the normal state, and
         * a compositor that refuses one must not stop the daemon that owns
         * the GPU, every agent and every model from coming up.
         */
        try {
            opts.dictation.bind()
        } catch (cause) {
            console.error(`[axond] dictation shortcut not registered: `
                + `${cause instanceof Error ? cause.message : String(cause)}`)
        }

        /*
         * Shut down on a signal — because otherwise `shutdown()` never runs.
         *
         * `axon daemon down` sends SIGTERM, and with no handler the process
         * dies where it stands: children keep running, the pidfile stays,
         * nothing disposes. That is not theoretical — it left a `pw-record`
         * holding the microphone across several daemon restarts, writing a
         * 17MB file nothing would ever read, and the next recording started
         * alongside it.
         *
         * `once`, so a second signal during shutdown kills us outright
         * rather than starting a second teardown. Registered here rather
         * than at construction: a CLIENT holding an `Axond()` to read paths
         * must not install process handlers.
         */
        const teardown = (signal: string) => {
            void shutdown()
                .catch(cause => console.error(`[axond] shutdown failed on ${signal}: `
                    + `${cause instanceof Error ? cause.message : String(cause)}`))
                .finally(() => process.exit(0))
        }
        process.once("SIGTERM", () => teardown("SIGTERM"))
        process.once("SIGINT", () => teardown("SIGINT"))
    }

    /** Stop listening and release the pidfile. Idempotent. */
    async function shutdown(): Promise<void> {
        await opts.agents.dispose()
        // After agents, so leases are released by agents leaving rather
        // than by bodies being pulled out from under them.
        await opts.labs.dispose()
        await opts.models.dispose()
        opts.machine.stop()
        opts.schedule.stop()
        /*
         * Release the MICROPHONE before anything else goes.
         *
         * The recorder is a child process, and a daemon that exits without
         * stopping it leaves it running: found in the wild holding the
         * microphone and writing a 17MB file with nothing left to read it,
         * having outlived the daemon that spawned it by several restarts.
         * An orphan is worse than a leak — it holds a device the next
         * daemon needs and its file grows without bound.
         */
        opts.dictation.cancel()
        await opts.net.stop()
        await opts.remote.close()
        await opts.server.close()
        opts.lifecycle.release()
    }

    return {
        serve: serve,
        shutdown: shutdown,
    }
}

export type ServiceT = ReturnType<typeof Service>
