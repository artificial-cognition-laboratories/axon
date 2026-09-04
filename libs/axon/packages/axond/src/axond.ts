import { join } from "node:path"
import { err } from "@arcforge/err"
import type { AxonCloudClient } from "@arcforge/cloud"
import { Boot, daemonPaths, Dispatch, Lifecycle, Preferences, Server } from "./control/index"
import { Machine } from "./machine/index"
import { Agents, Credential, Supervise } from "./agents/index"
import { Models } from "./models/index"
import { Jobs, Runner } from "./jobs/index"
import { Schedule } from "./schedule/index"
import { Dictation } from "./dictation/index"
import type { Job } from "./jobs/index"
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
     * Supplied rather than derived where the caller knows better: the daemon
     * is started from a CLI, from a systemd unit, and from a test, and each
     * knows where its own binary is.
     *
     * Defaults to this package's own `bin/axond.ts`, which is a real
     * entrypoint — unlike this file, which is a module. The previous default
     * was the empty string, so an unsupplied entrypoint spawned `bun "" serve`;
     * bun printed its help into the daemon log and `up` reported only that the
     * socket never bound. A default that cannot work is worse than none.
     */
    entrypoint?: string
    /**
     * Boot the agent that answers a job.
     *
     * Supplied by a caller that holds a Platform — preparing a blueprint is
     * the platform's work and needs the project stack, which is deliberately
     * not in the daemon. See Jobs.
     */
    startJob?: (job: Job) => Promise<{ session: string }>
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
        entrypoint: opts.entrypoint ?? new URL("../bin/axond.ts", import.meta.url).pathname,
        /**
         * Replace a daemon from an older build — unless it is supervising
         * agents, because shutdown disposes every one of them.
         *
         * A thunk: `agents` is constructed below, in terms of things built
         * here, so the answer is read at the moment it is needed rather than
         * captured now. Reading a live count is also the only correct timing —
         * a machine idle at construction may not be idle at the call.
         */
        onStale: () => agents.list().length === 0,
    })

    const machine = Machine({
        /*
         * The process groups Axon owns, for attributing this machine's usage.
         *
         * An agent's pid IS its group leader — that is why `agents.signal`
         * kills `-record.pid` — so the records already carry the set. A thunk
         * because `agents` is built below and the membership changes anyway;
         * it is only read from a timer, long after both exist.
         */
        groups: () => agents.list().map(record => record.pid).filter((pid): pid is number => typeof pid === "number"),
        ...(opts.residencyRoot !== undefined ? { residencyRoot: opts.residencyRoot } : {}),
    })
    /**
     * Who is signed in on this machine.
     *
     * Read from the store rather than handed in, because nothing hands a
     * daemon a login: it is started by systemd at boot, by a keybind, by
     * nothing at all. `opts.cloud` still wins where a caller supplies one —
     * that is how a test pins an account — and the store is the answer for
     * everyone else. Lazy, so construction still touches nothing.
     */
    const credential = Credential({ version: version })

    /**
     * What the daemon holds on a confined agent's behalf.
     *
     * Always built now. It used to exist only when a caller passed a
     * credential, and no caller did — so `bin/axond.ts` produced a daemon that
     * threw DAEMON_NOT_WIRED on every spawn, which read as an unimplemented
     * feature rather than a missing login. The credential is resolved at the
     * spawn that needs it, and says which of the two is actually wrong.
     */
    const supervise = Supervise({
        cloud: opts.cloud ?? (() => credential.client()),
        // Models is assembled below. The thunk is called only when an agent
        // resolves its inference roles, after the daemon composition is complete.
        local: () => ({
            catalogue: () => models.local(),
            run: (model, input) => models.run({ model, input }),
        }),
    })

    const agents = Agents({
        supervise: supervise,
        // Identity belongs to the machine domain — the agents domain names the
        // box on each record rather than probing it a second time.
        machineId: () => machine.identity.current().id,
        ...(opts.agentsRoot !== undefined ? { root: opts.agentsRoot } : {}),
    })
    // The machine owns admission and residency: a load is a claim on video
    // memory, and the thing that owns the GPU decides whether it fits.
    /**
     * The daemon's switches. One file, read on every ask.
     *
     * Not cached in a variable: a preference changed by `axon daemon autoload
     * off` has to take effect on the next request, and a value read once at
     * boot would need the daemon restarted to notice.
     */
    const preferences = Preferences({ path: join(paths.root, "preferences.json") })

    const models = Models({
        machine: machine,
        autoload: () => preferences.flag("autoload", true),
        ...(opts.modelsRoot !== undefined ? { root: opts.modelsRoot } : {}),
    })
    /**
     * Work delegated to an agent, and the record of what happened.
     *
     * `start` is handed in rather than reached for: booting a job's agent
     * needs a PREPARED blueprint, and preparing one needs the whole project
     * stack, which is the platform's. A daemon given none still records jobs
     * and leaves them queued — the honest state for a process that cannot boot
     * anything, and far better than refusing to remember what a person typed.
     */
    /**
     * What boots the agent a job asks for.
     *
     * A thunk over `agents` for the same reason `onStale` is one: `agents` is
     * built below, and this is only ever called long after both exist. The
     * runner holds a Platform lazily — see Runner on why the daemon may build
     * one without inverting the platform/daemon direction.
     */
    const runner = Runner({
        agents: { supervise: (input: never) => agents.supervise(input) } as never,
        version: version,
        report: {
            say: (ref, text) => { jobs.say({ ref: ref, text: text, by: { kind: "agent", session: "runner" } }) },
            finish: (ref, summary) => { jobs.finish({ ref: ref, summary: summary, by: { kind: "agent", session: "runner" } }) },
            fail: (ref, reason) => { jobs.fail({ ref: ref, reason: reason, by: { kind: "agent", session: "runner" } }) },
        },
    })

    const jobs = Jobs({
        root: join(paths.root, "jobs"),
        machineId: () => machine.identity.current().id,
        // `opts.startJob` still wins where a caller supplies one — that is how
        // a test boots nothing — and the runner is the answer for everyone
        // else. Without it every job sat queued forever.
        start: opts.startJob ?? (job => runner.start(job)),
    })

    const schedule = Schedule({ root: paths.root })

    /**
     * Speak, and the words are typed where the cursor is.
     *
     * Built here rather than reaching for its own model store: it goes through
     * `models`, so the weight it uses is the SAME resident copy everything else
     * shares. A dictation domain that loaded its own would put a second copy of
     * Whisper in memory beside the first and account for neither.
     */
    const dictation = Dictation({ models: models, preferences: preferences })

    const dispatch = Dispatch({
        domains: {
            machine: machine,
            agents: agents,
            models: models,
            jobs: jobs,
            schedule: schedule,
            dictation: dictation,
            preferences: preferences,
            /**
             * Who is signed in. A domain of one verb, because a surface asking
             * "should I show a login wall" should not have to reach into the
             * agents domain to find out.
             */
            identity: { read: () => credential.identity() },
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

        preferences: preferences,
        /** Same handle the dispatch exposes, so a local caller has it too. */
        identity: { read: () => credential.identity() },

        machine: machine,
        agents: agents,
        models: models,
        jobs: jobs,
        schedule: schedule,
        dictation: dictation,

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
            schedule.start()
            // What is on disk, read once at start rather than per render —
            // see Models.state().
            void models.refresh()

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
                dictation.bind()
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
                void this.shutdown()
                    .catch(cause => console.error(`[axond] shutdown failed on ${signal}: `
                        + `${cause instanceof Error ? cause.message : String(cause)}`))
                    .finally(() => process.exit(0))
            }
            process.once("SIGTERM", () => teardown("SIGTERM"))
            process.once("SIGINT", () => teardown("SIGINT"))
        },

        /** Stop listening and release the pidfile. Idempotent. */
        async shutdown(): Promise<void> {
            await agents.dispose()
            await models.dispose()
            machine.stop()
            schedule.stop()
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
            dictation.cancel()
            await server.close()
            lifecycle.release()
        },
    }
}

export type AxondT = ReturnType<typeof Axond>
