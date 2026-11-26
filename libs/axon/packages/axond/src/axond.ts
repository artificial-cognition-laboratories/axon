import { join } from "node:path"
import type { AxonEngineRequest, AxonEngineRawEvent, EngineCapability } from "@arcforge/types"
import type { AxonCloudClient } from "@arcforge/cloud"
import { Attach, Boot, Caller, daemonPaths, Dispatch, distribution, Lifecycle, Preferences, profileRoot, Remote, RemoteServer, Server, Service, Tunnel } from "./control/index"
import { Key, Machine } from "./machine/index"
import { Directory, Net, type SidecarMode } from "./net/index"
import { Agents, Credential, Supervise, Usage } from "./agents/index"
import { Models, Runtimes } from "./models/index"
import { Jobs, Runner, Workspaces, type Job } from "./jobs/index"
import { Launcher } from "./launcher/index"
import { Schedule } from "./schedule/index"
import { Dictation } from "./dictation/index"
import { LAB_IDS, Labs, type LabState } from "./labs/index"
import type { DaemonPaths } from "../types/index"

export type AxondOpts = {
    /**
     * Join the machine network, and how. Absent: this daemon stays off it.
     *
     * Explicit until enrollment exists — who may join, and when, is decided by
     * sign-in and the directory (handoff, Pass 2), and a daemon must not reach
     * the network before that answer does. `offline` dials direct addresses
     * only: machines on one network, and tests.
     */
    network?: { mode: SidecarMode; dialTimeoutMs?: number; directoryTtlMs?: number; heartbeatMs?: number }
    /** Override where the socket, pidfile and log live. Tests point this at a scratch dir. */
    local?: { catalogue(): Promise<EngineCapability[]>; run(model: string, input: unknown): Promise<unknown>; stream(model: string, request: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> }
    root?: string
    /** This build's version — stamped into `status` and reported to clients. */
    version?: string
    /** Where resource holds are written. Tests point this at a scratch dir. */
    residencyRoot?: string
    /**
     * Present when this Axond is EMBEDDED in another process — a terminal
     * supervising the agents it boots — rather than being the machine daemon.
     * The machine's labs, and every body in them, run in the daemon; `labs`
     * reads their state from there, so an agent's body is still accounted to
     * it. Absent: this process is the daemon, and its own labs are the labs.
     */
    embedded?: { labs(): Promise<LabState[]> }
    /** Where running-agent records are written. Tests point this at a scratch dir. */
    agentsRoot?: string
    /**
     * The human decider for a policy escalation.
     *
     * Supplied by the surface that HAS a person watching — the TUI. Its
     * absence means deny: a daemon with no surface to ask cannot answer on
     * someone's behalf, and defaulting to allow would make an unattended agent
     * strictly more privileged than an attended one.
     *
     * Threaded through to `Supervise`, which binds it per spawn and hands it to
     * the LINK's supervisor-side services. It never crosses into the box — the
     * agent reaches it through the `escalate` verb and never holds the
     * callback, which is the whole reason it lives on this side.
     *
     * A THUNK-shaped dependency like `cloud`, for the same reason: the platform
     * owns the decider and the daemon supervises the platform's agents, so a
     * value here would force one to exist before the other.
     */
    decide?: (input: { agent: string; sessionId: string }, call: unknown) => Promise<boolean>
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
    /** Where Axon-managed inference runtimes are cached. */
    runtimesRoot?: string
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
         * The RUNNING daemon is asked, over its socket. This used to read
         * `agents.list()` — the agents of THIS process's Axond, which is the
         * CLI's in-process handle and supervises nothing — so the answer was
         * always "idle" and every update killed whatever the old daemon ran.
         *
         * Refused while busy, the next request asks again (Connection retries
         * a failed launch after its cooldown), so the old daemon is replaced
         * at the first moment it is idle. `agents list` is a verb every build
         * has answered, which is what makes it safe to put to an older one.
         */
        onStale: async () => {
            const running = await Caller({ paths: paths })(["agents", "list"]) as unknown[]
            return running.length === 0
        },
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
    const credential = Credential({ version: version, store: paths.store })

    /**
     * What the daemon holds on a confined agent's behalf.
     *
     * Always built now. It used to exist only when a caller passed a
     * credential, and no caller did — so `bin/axond.ts` produced a daemon that
     * threw DAEMON_NOT_WIRED on every spawn, which read as an unimplemented
     * feature rather than a missing login. The credential is resolved at the
     * spawn that needs it, and says which of the two is actually wrong.
     */
    const preferences = Preferences({ path: join(paths.root, "preferences.json") })

    // One machine-wide runtime manager shared by every agent and model adapter.
    const runtimes = Runtimes(opts.runtimesRoot !== undefined ? { root: opts.runtimesRoot } : {})

    const models = Models({
        machine: machine,
        runtimes: runtimes,
        autoload: () => preferences.flag("autoload", true),
        ...(opts.modelsRoot !== undefined ? { root: opts.modelsRoot } : {}),
    })

    const supervise = Supervise({
        cloud: opts.cloud ?? (() => credential.client()),
        // Each agent's cost, part by part. Labs are read through a thunk: they
        // are built below, and a sample is only ever taken after both exist.
        usage: Usage({
            machine: machine,
            labs: opts.embedded ? opts.embedded.labs : () => Promise.all(LAB_IDS.map(id => labs.all[id].state())),
            host: { pid: process.pid, name: opts.embedded ? "terminal" : "daemon" },
        }),
        ...(process.env.AXON_PROFILE ? { profiles: profileRoot(process.env.AXON_PROFILE, paths.root) } : {}),
        // Without this the daemon has no way to ask anybody anything, so every
        // escalation is refused by a supervisor that never had a decider —
        // which is how a TUI showed "needs approval, and nothing was listening"
        // while the user was sitting right there.
        ...(opts.decide ? { decide: opts.decide } : {}),
        local: () => opts.local ?? ({
            catalogue: () => models.local(),
            run: (model, input) => models.run({ model: model, input: input }),
            stream: (model, request) => models.stream({ model: model, request: request }),
        }),
    })

    const agents = Agents({
        store: paths.store,
        isolated: paths.isolated,
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
     * What boots an agent the daemon is asked to run, by reference — a job's,
     * or a lab's scenario run. It holds a Platform lazily: see Launcher on why
     * the daemon may build one without inverting the platform/daemon direction.
     */
    const launcher = Launcher({
        agents: agents,
        version: version,
    })
    const runner = Runner({
        launcher: launcher,
        report: {
            say: (ref, text) => { jobs.say({ ref: ref, text: text, by: { kind: "agent", session: "runner" } }) },
            finish: (ref, run, summary) => { jobs.finish({ ref: ref, run: run, summary: summary, by: { kind: "agent", session: "runner" } }) },
            fail: (ref, run, reason) => { jobs.fail({ ref: ref, run: run, reason: reason, by: { kind: "agent", session: "runner" } }) },
        },
    })

    const jobs = Jobs({
        root: join(paths.root, "jobs"),
        workspace: paths.root,
        machineId: () => machine.identity.current().id,
        // `opts.startJob` still wins where a caller supplies one — that is how
        // a test boots nothing — and the runner is the answer for everyone
        // else. Without it every job sat queued forever.
        start: opts.startJob ?? (job => runner.start(job)),
    })
    const workspaces = Workspaces({
        root: paths.root,
        machineId: () => machine.identity.current().id,
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

    // This machine's identity on the network — in the store, not the cache.
    const key = Key({ path: join(paths.store, "machine", "key") })
    const directory = Directory({
        cloud: () => credential.client(),
        account: () => credential.account(),
        key: key,
        about: () => {
            const identity = machine.identity.current()
            return { name: identity.hostname, platform: identity.platform, arch: identity.arch }
        },
        distribution: distribution(),
        ttlMs: opts.network?.directoryTtlMs ?? 30_000,
    })
    const net = Net({
        root: paths.root,
        key: key,
        directory: directory,
        heartbeatMs: opts.network?.heartbeatMs ?? 60_000,
        mode: opts.network?.mode ?? "n0",
        dialTimeoutMs: opts.network?.dialTimeoutMs ?? 5_000,
        report: event => console.error(`[axon-net] ${JSON.stringify(event)}`),
    })
    const remote = RemoteServer({
        socket: join(paths.root, "remote.sock"),
        authorize: key => directory.authorize(key),
        surface: peer => Remote({ peer: peer, agents: agents, machine: machine, models: models, schedule: schedule }),
        attach: Attach({ agents: agents }),
    })

    // Labs are machine-wide: a display, a port, and a game client can only
    // belong to one process on this box.
    const labs = Labs({ root: join(paths.root, "worlds"), launcher: launcher, build: distribution() })

    const dispatch = Dispatch({
        domains: {
            machine: machine,
            agents: agents,
            models: models,
            jobs: jobs,
            schedule: schedule,
            dictation: dictation,
            labs: labs.all,
            preferences: preferences,
            /**
             * Who is signed in. A domain of one verb, because a surface asking
             * "should I show a login wall" should not have to reach into the
             * agents domain to find out.
             */
            identity: { read: () => credential.identity() },
            /** This machine on the network: up with its key and addresses, or down with why. */
            net: { status: () => net.status(), join: () => net.join() },
            /** The other machines on this account's network, and calling them. */
            machines: net.machines,
            // Not a domain — one fact only the daemon can report. A client
            // reading a pidfile knows a daemon is up and cannot know what it
            // was built from.
            version: () => version,
        },
    })

    const server = Server({
        paths: paths,
        dispatch: dispatch,
        tunnel: Tunnel({ machines: net.machines }),
    })

    const service = Service({
        paths: paths,
        net: net,
        remote: remote,
        network: opts.network !== undefined,
        lifecycle: lifecycle,
        server: server,
        machine: machine,
        schedule: schedule,
        models: models,
        dictation: dictation,
        agents: agents,
        labs: labs,
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
        workspaces: workspaces,
        schedule: schedule,
        dictation: dictation,
        labs: labs,
        net: net,

        serve: service.serve,
        shutdown: service.shutdown,
    }
}

export type AxondT = ReturnType<typeof Axond>
