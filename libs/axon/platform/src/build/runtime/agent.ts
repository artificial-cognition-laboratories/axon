import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { Axon } from "@arcforge/core"
import type { AxonHost, AxonT } from "@arcforge/core"
import type { AxonEscalate } from "@arcforge/types"
import type { AxonBlueprint, AxonPartialBlueprint, SupervisorToAgent } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"
import { err } from "@arcforge/err"
import type { AxonCloudClient } from "@arcforge/cloud"
import { BuildRecorder, span } from "@arcforge/session"
import { Blueprint } from "../blueprint"
import { readPolicy, ProfileConfigFile } from "../extensions"
import { advances, stageFor, unitFor } from "./progress"
import type { BootProgress, BootStage, UnitTiming } from "./progress"
import { Frame } from "../frame"
import { ReloadWatch } from "./reload-watch"
import type { ProjectT } from "../project"
import type { StoreT } from "../../services/store"

type AgentOpts = {
    project: ProjectT
    /** Platform invocation directory inherited by every capsule incarnation. */
    cwd: string
    /** The platform's authenticated cloud client — the agent runs AS the logged-in user. */
    cloud: AxonCloudClient
    /** Registers this process in ~/.axon/running for the duration of the instance — see Store().running. */
    store: StoreT
    /** Resume an existing session instead of minting a new one — the id of a sessions/<id>.jsonl on disk. */
    session?: string
    /** Platform-owned services exposed to this instance's capsule. */
    host?: AxonHost
    /**
     * The platform's policy decider, bound to THIS agent.
     *
     * Bound rather than generic because a grant is written against an agent
     * name, and the decider has no way to know which agent raised a call — the
     * capsule only reports the fn and its arguments. Runtime() closes over the
     * name when it builds this.
     */
    escalate?: AxonEscalate
    parentSessionId?: string | null
    rootSessionId?: string
    depth?: number
    /** Job directory this run answers, for correlation — see RunningRecord.job. */
    job?: string
    /**
     * A local control channel this instance is listening on, published on
     * the running record so an editor can find and dial it.
     *
     * Supplied by the surface that HAS one — the TUI serves a conversation
     * something can drive; a headless `axon run` does not, and passes
     * nothing. Threaded through here rather than written separately
     * because the record is created once, at the moment the runtime comes
     * up, and a second writer racing this one is how a reader ends up
     * seeing a port whose process is not ready.
     */
    control?: { port: number; token: string }
    /**
     * Boot this agent as a CONFINED PROCESS instead of an in-heap runtime.
     *
     * Supplied by the caller that owns the supervisor (Instances), because
     * spawning a box needs sockets and a policy this layer has no business
     * resolving.
     *
     * REQUIRED. An agent is always its own process — there is no in-heap
     * variant to fall back to. The path that used to exist when this was
     * absent booted agent code, its tools and every model-emitted block
     * inside the CALLER's heap, where no OS box surrounds it and policy
     * cannot be enforced against the process doing the enforcing. That is a
     * hole in the user policy contract, not an optimisation, so the option
     * to open it is gone rather than defaulted.
     *
     * Sits BELOW the whole build: the scan, the compile, the blueprint and
     * the session all run before it.
     */
    confined: (input: {
        blueprint: AxonPartialBlueprint
        sessionId: string
        /** Rescan the project and return the blueprint that produced — what a reload sends. */
        rescan: () => Promise<AxonPartialBlueprint>
    }) => Promise<LinkedRuntime>

    /**
     * Watch the project for changes and hot-reload. Default true — a TUI or
     * `axon dev` instance is edited while it runs.
     *
     * A script that boots several agents and exits gets nothing from this and
     * pays a watcher per instance for it, so Axon()/Fleet() pass false. Only
     * the watching is skipped: the same blueprint is loaded, the same runtime
     * boots, and reload() still works when called directly.
     *
     * This was declared and documented exactly like this while NOTHING READ
     * IT — see ReloadWatch. Saving a file in an agent's directory reloaded
     * nothing, and the reloads users did see came from the profile watcher
     * firing reloadAll() for unrelated reasons.
     */
    watch?: boolean
    /**
     * Live boot progress, for a surface that shows one.
     *
     * A cold boot is seconds long — mostly `bun install` — and reported as a
     * single word it looks hung. This fires as each stage begins so the caller
     * can say which. Purely observational: it cannot fail the boot, and a
     * caller that passes nothing (every headless one) is unaffected.
     *
     * Separate from the session log rather than read back off it: the log is
     * the durable record, written through an async chain, and a status bar
     * needs the event as it happens, not after it lands on disk.
     */
    onProgress?: (progress: BootProgress) => void
    /**
     * What each timed unit of the build cost, as its span closes.
     *
     * The spans already measure this for the log; this only forwards it so a
     * surface can report the cost without timing anything itself. Same
     * observational contract as onProgress — it cannot fail the boot.
     */
    onTiming?: (timing: UnitTiming) => void
}

/**
 * Agent — the running instance of one project's blueprint. Boots once,
 * then reacts to the project's file watcher by rescanning and pushing the
 * fresh AxonPartialBlueprint through the live runtime's update() — the
 * kernel fans it out to its own organs (engine, loop, capsule). No reboot:
 * update() is core's contract for exactly this.
 *
 * Watching is the project's concern (Watcher knows only "a file changed"),
 * turning that into "reload the agent" is this module's job.
 *
 * Every caller that boots an instance (Agents(), `axon dev`) converges
 * here, so the running-registry write lives at this one seam rather than
 * being each caller's responsibility to remember.
 */
export async function Agent(opts: AgentOpts) {
    const { project } = opts
    const blueprint = Blueprint({ root: project.root })

    /**
     * The active profile's policy ceiling, re-read on every load.
     *
     * Resolved HERE rather than inside Blueprint(), which knows a root
     * directory and nothing about profiles, auth or deployment. This module
     * already holds the store, so it is the nearest place that legitimately
     * knows which user is running.
     *
     * Re-read per load rather than captured once, so a reload picks up an
     * edited ceiling. That is the honest boundary of "takes effect on save":
     * the capsule's policy is fixed at construction, so a tightened profile
     * applies from the next boot or reload — not retroactively to a call
     * already in flight.
     *
     * Never throws. An unreadable or absent profile means no ceiling, which is
     * the correct state for `axon run` outside one and for a deployment. A
     * ceiling that failed CLOSED here would make a broken config unbootable;
     * one that fails open is the same posture the rest of the profile takes,
     * and the config's own loader is what reports the breakage.
     */
    async function profileCeiling(): Promise<AxonPartialBlueprint["profilePolicy"]> {
        try {
            const active = opts.store.profiles.active()
            if (!active) return undefined
            const policy = await readPolicy(active.root)
            return Object.keys(policy).length > 0 ? (policy as AxonPartialBlueprint["profilePolicy"]) : undefined
        } catch {
            return undefined
        }
    }

    /**
     * The active profile's declared inference sources, re-read on every load.
     *
     * Sibling of profileCeiling() above and resolved for the same reason: this
     * module holds the store, so it is the nearest place that legitimately
     * knows which user is running. Blueprint() knows a root directory and
     * must not learn about profiles.
     *
     * Re-read per load so a provider added or a key connected takes effect on
     * the next boot or reload, rather than only after restarting the terminal.
     *
     * Never throws. An unreadable profile means no providers, which is the
     * correct state for `axon run` outside one and for a deployment — and a
     * throw here would make a broken profile config unbootable, when the
     * config's own loader is what reports the breakage.
     */
    async function profileProviders(): Promise<AxonPartialBlueprint["profileProviders"]> {
        try {
            const active = opts.store.profiles.active()
            if (!active) return undefined
            const { providers } = await ProfileConfigFile(active.root)
            // Carried VERBATIM, including an empty array. `[]` is a user who
            // declared no providers and absent is one who was never asked —
            // collapsing the first into the second would silently hand them
            // the default pool they had deliberately cleared.
            return providers ? [...providers] : undefined
        } catch {
            return undefined
        }
    }

    /**
     * The build's own log, opened before anything can fail.
     *
     * The session id is minted HERE rather than by Axon(), because the
     * whole point is that the build reports into a session that exists
     * before there is a runtime to open one. Axon() is handed the same id
     * below, so a successful build and the run it produced are one file —
     * not a build log orphaned beside the session it belongs to.
     *
     * The data path mirrors Blueprint()'s own, resolved through the same
     * Frame() so the two cannot disagree. That location is a convention, not
     * a configurable, and resolving it here rather than from a loaded
     * blueprint is what lets the log exist before the scan.
     */
    const sessionId = opts.session ?? randomUUID()
    /**
     * Translate recorded build events into boot progress for the caller.
     *
     * Reads the events already being emitted for the log — nothing new is
     * measured — and forwards only the few that name a stage (progress.ts).
     * One observer on the recorder covers every emitter, so no individual
     * call site needs intercepting.
     */
    const recorder = BuildRecorder({
        root: Frame({ root: project.root, kind: "agent" }).path("data"),
        sessionId,
        ...(opts.onProgress || opts.onTiming ? { onEmit: reportProgress } : {}),
    })

    /** The last stage reported, so the bar only ever moves forward. */
    let reported: BootStage | null = null

    function raise(progress: BootProgress): void {
        // Monotonic: `build:typegen` belongs to prepare but runs after the
        // cognet compiles, so following the events literally would read
        // "Preparing… → Compiling… → Preparing…". Progress that goes backwards
        // reads as the work having restarted.
        if (!advances(reported, progress.stage)) return
        reported = progress.stage
        opts.onProgress?.(progress)
    }

    function reportProgress(type: string, data: unknown): void {
        // A closing span carries what it cost. Reported alongside progress so
        // a surface can show "4 mods, 15 tools (42ms)" without timing the
        // build itself — the span already measured it.
        const unit = unitFor(type)
        if (unit) {
            const durationMs = (data as { durationMs?: number }).durationMs
            if (typeof durationMs === "number") opts.onTiming?.({ unit, durationMs })
            return
        }

        const stage = stageFor(type)
        if (!stage) return
        // The modules stage is the one with an honest count — the agent
        // declares them, so the total is known before the work starts.
        // Everything else reports a bare stage (see BootProgress).
        const specifiers = type === "build:modules:start"
            ? (data as { specifiers?: string[] }).specifiers
            : undefined
        raise(
            specifiers?.length
                ? { stage, total: specifiers.length, detail: specifiers[0] }
                : { stage },
        )
    }

    /**
     * The warnings currently live for this agent, keyed by domain+message.
     *
     * ── Why this is instance-scoped and not per-build ───────────────────────
     *
     * A warning is a fact about the agent's CURRENT state — "@axon/arxiv's
     * tools do not compile" — not about the build that noticed it. Every
     * build re-derives the whole set from scratch, so a broken module is
     * rediscovered by boot, by prepare, by load, and by every reload after.
     * Emitting on each rediscovery stacked identical cards until the timeline
     * was mostly one repeated paragraph, which reads as many problems rather
     * than one persistent one.
     *
     * So emission is edge-triggered: a warning is announced when it APPEARS
     * and stays silent while it persists. `syncWarnings` replaces the set
     * wholesale from each build's output, which is what makes the suppression
     * safe to hold across reloads — a warning the user has fixed drops out of
     * the new set, so if it ever returns it announces itself again.
     */
    const liveWarnings = new Set<string>()

    type ScanWarning = { domain: string; error: string; cause?: unknown }

    function warningKey(warning: ScanWarning): string {
        return `${warning.domain}\u0000${warning.error}`
    }

    function emitWarning(warning: ScanWarning): void {
        recorder.emit("build:warning", {
            domain: warning.domain,
            message: warning.error,
            ...(warning.cause ? { error: warning.cause as never } : {}),
        })
    }

    /**
     * Announce whatever is newly wrong, and forget whatever has been fixed.
     *
     * Takes the COMPLETE warning set a build produced, not an increment: the
     * scan is the authority on what is currently broken, so anything absent
     * from it is resolved by definition. Called once per build with every
     * stage's warnings concatenated — prepare and load both scan, and a
     * module that will not compile is found by each.
     */
    function syncWarnings(warnings: ScanWarning[]): void {
        const current = new Set<string>()
        for (const warning of warnings) {
            const key = warningKey(warning)

            // `current` is checked BEFORE it is added, so a warning appearing
            // twice in ONE batch announces once.
            //
            // That is the common case, not an edge case: prepare() runs a full
            // blueprint.load() internally and returns its warnings, then boot()
            // loads again and concatenates both lists. A module that will not
            // compile is therefore found by each scan and arrives here twice,
            // in the same array, at the same millisecond. Checking only
            // `liveWarnings` (what the PREVIOUS build announced) let both
            // through — two identical cards for one broken module, which is
            // exactly the duplication this function exists to prevent.
            if (current.has(key) || liveWarnings.has(key)) {
                current.add(key)
                continue
            }
            current.add(key)
            emitWarning(warning)
        }

        // Replace rather than merge — a key that is gone is a warning that no
        // longer applies, and keeping it would suppress the announcement if
        // the same breakage came back.
        liveWarnings.clear()
        for (const key of current) liveWarnings.add(key)
    }

    /**
     * The booted agent — an in-heap runtime, or a linked process.
     *
     * `booted` rather than `runtime` for the linked case, because everything
     * below that name (reload, serve, the watcher) is about an `AxonT` in this
     * heap. A linked agent returns before any of it is wired.
     */
    // A linked agent returns HERE, before any of the in-heap machinery below
    /**
     * Everything both boot paths share: prepare, load, warnings, identify,
     * flush — ending with the blueprint the runtime will be built from.
     *
     * Extracted rather than duplicated because this is the expensive and
     * failure-prone half, and two copies would drift on exactly the stages
     * that matter (a scan warning reported by one path and not the other is
     * indistinguishable from a build that produced none).
     *
     * Runs INSIDE the caller's "build" span — both callers open one, so this
     * stays a plain function and the span stays where the timing belongs.
     */
    async function build(): Promise<AxonPartialBlueprint> {
            const prepared = await span(
                recorder,
                "build:prepare",
                { root: project.root },
                // The reporter is what gives the prepare span an interior:
                // framework, modules, cognet, tree and typegen each report
                // themselves through it, so a five-second build decomposes
                // instead of being one opaque bar.
                () => project.prepare({ report: (type, data) => recorder.emit(type as never, data as never) }),
                result => ({ warnings: result.warnings.length }),
            )

            const { blueprint: loaded, warnings } = await span(
                recorder,
                "build:load",
                { root: project.root },
                async () => blueprint.load({ profilePolicy: await profileCeiling(), profileProviders: await profileProviders() }),
                result => ({
                    // A scan that produced no agent identity is a scan that
                    // failed to find one — recorded as the empty string
                    // rather than invented, so the log says what was read.
                    agent: result.blueprint.agent?.name ?? "",
                    tools: result.blueprint.tools?.length ?? 0,
                    prompts: result.blueprint.prompts?.length ?? 0,
                    modules: result.blueprint.modules?.length ?? 0,
                    warnings: result.warnings.length,
                }),
            )
            if (loaded.agent?.name) recorder.identify(loaded.agent.name)

            // Scan warnings — a tool or prompt shadowed by one of the same
            // name, where the scope stays coherent and one export is
            // unreachable. Reported as build:warning above rather than
            // committed after boot: they are facts about the BUILD, and
            // emitting them from the runtime meant a build that never
            // reached one reported nothing. (It also emitted
            // "axon:scan:warning", which is not in the event registry — so
            // those commits were failing type-check at the call site and
            // would never have landed.)
            //
            // Both stages' warnings go in as ONE set. prepare() scans and
            // load() scans again, so a module that will not compile is found
            // by each — passing them separately would announce the first set,
            // then immediately treat the second as the complete picture and
            // re-announce everything prepare() already reported.
            syncWarnings([...prepared.warnings, ...warnings])
            // Drain before the session opens. AxonSession restores its seq
            // high-water mark by READING this file, so any build append
            // still queued at that moment is invisible to it and both
            // writers then issue the same number. The queue is a handful of
            // small lines; waiting costs nothing beside the boot it precedes.
            await recorder.flush()

            return { ...loaded, session: { id: sessionId } }
    }
    // An agent is ALWAYS its own process. There is no second boot path to
    // choose between — the build above is shared by nothing else, and the
    // supervisor takes it from here.
    return await bootLinked(opts.confined)

    /**
     * The confined boot.
     *
     * Reuses `build()` — the scan, compile, blueprint load, warnings and
     * identify — and diverges only at the final step, where the in-process
     * path constructs `Axon()` and this one hands the prepared blueprint to a
     * supervisor. Sharing that stage is the whole reason the fork sits this
     * deep rather than at the call site.
     */
    async function bootLinked(confined: NonNullable<AgentOpts["confined"]>): Promise<LinkedRuntime> {
        return span(recorder, "build", { root: project.root }, async () => {
            const loaded = await build()

            /**
             * The build is done; the runtime is coming up.
             *
             * Raised HERE because there is no build event to map it from —
             * `axon:boot:start` is committed by Axon()'s own session, inside
             * the agent, and never reaches this recorder. `stageFor` says as
             * much and expects Agent() to raise it directly at this exact
             * moment. Nothing did, so `booting` was a stage the type declared,
             * the display ordered, and no code ever emitted: a surface showing
             * it had a row that could only ever read as skipped, and the time
             * the runtime took to come up was silently attributed to whatever
             * ran before it.
             */
            raise({ stage: "booting" })

            const linked = await confined({
                blueprint: { ...loaded, session: { id: sessionId } },
                sessionId,
                /**
                 * A REAL reload: rescan the project, then hand the agent the
                 * blueprint that produced.
                 *
                 * The first cut re-sent the blueprint captured at boot, which
                 * is a reload that cannot observe an edit — a tool the author
                 * had just added never appeared, and the call reported success.
                 * `build()` is the same scan+compile+load the boot path runs,
                 * so a reload and a fresh boot see the project identically.
                 *
                 * The session id is preserved: a reload is the same
                 * conversation with new code, and minting a new one would
                 * split the log at every edit.
                 */
                rescan: () => build().then(next => ({ ...next, session: { id: sessionId } })),
            })
            // The supervisor-held session owns this log from here, so build
            // events commit through the same writer the agent's own will —
            // one serialized writer per file, which the envelope depends on.
            recorder.handOver((type, data) => {
                void linked.session.commit(type as never, data as never)
            })

            /**
             * The liveness record is the DAEMON'S to write.
             *
             * It was written here, with the agent's pid, because this was the
             * only place that knew it. The daemon supervises now — it spawns
             * the process, holds its link, and is still running when the
             * record needs removing — so it owns the record too. Writing it in
             * both places gave one fact two owners, which is the shape that
             * drifts.
             *
             * Everything the record carries beyond the pid travels across the
             * seam: see AgentSupervisor.supervise.
             */
            /**
             * Hot reload on edit - the thing `opts.watch` has always claimed.
             *
             * Off when the caller declined (a script booting several agents
             * gets nothing from it and pays a watcher each).
             *
             * `project.watcher.during` is what stops a reload's own writes
             * from scheduling the next one: the installer already suspends it
             * around `bun install`, and a rescan writes generated types and a
             * lockfile the same way. Wrapping the reload in it makes those
             * writes the reload's own business rather than the next reload's
             * trigger.
             */
            if (true) return linked  // MUTANT

            const stopWatching = ReloadWatch({
                watcher: project.watcher,
                reload: () => project.watcher.during(
                    () => linked.reload(),
                    { selfReloads: true },
                ),
            })

            // Stop watching when the agent stops. A watcher outliving its
            // agent holds an fs handle open and reloads a runtime that is
            // gone - and every boot would add another.
            return {
                ...linked,
                async shutdown() {
                    stopWatching()
                    await linked.shutdown()
                },
            }
        })
    }
}


/** Bun.serve throws synchronously when the port is taken — match the address-in-use shape. */
function isAddrInUse(cause: unknown): boolean {
    const code = (cause as { code?: string })?.code
    const message = cause instanceof Error ? cause.message : String(cause)
    return code === "EADDRINUSE" || /address already in use|in use|EADDRINUSE/i.test(message)
}

/**
 * An agent running as its own process, reached over the link.
 *
 * Deliberately has NO `current`: there is no in-heap runtime to hand out, and
 * offering one that returned undefined would let a consumer forget the
 * difference until runtime. The session is here because the SUPERVISOR holds
 * it — the agent appends through `commit` and can never rewrite the record.
 */
export type LinkedRuntime = {
    kind: "linked"
    /** This agent's session id — the same accessor the process variant exposes. */
    sessionId: string
    link: SupervisorToAgent & { close(): void }
    /** The supervisor-held log. Read directly; written only by the agent's commits. */
    session: AxonSessionT
    /**
     * Where surfaces watch this agent.
     *
     * The linked counterpart of `runtime.bus`. A linked agent has no in-heap
     * runtime to announce on, so its commits fan out here — same events, same
     * order, one hop earlier than the log.
     */
    bus: { onAny(handler: (type: string, data: unknown) => void): () => void }
    /**
     * The blueprint this agent booted with — held on THIS side.
     *
     * The supervisor prepares it (scan, compile, resolve) and writes it beside
     * the sockets, so it is already here; the agent is handed a copy rather
     * than being the source of one. Exposed because every surface fact a
     * header renders — the agent's name, its home, what it is carrying —
     * reads off this, and reaching across the link for values the supervisor
     * already holds would be a round trip to learn what it just wrote.
     *
     * Live for as long as this boot is: a reload replaces the whole handle.
     */
    blueprint: AxonBlueprint
    /**
     * The resolved inference roles, held supervisor-side.
     *
     * A linked agent has no in-heap kernel to read `engines` off, so this is
     * where a model picker rebinds and where a header reads what actually
     * answered. Undefined for a cognet that declared no roles.
     */
    engines?: { select(model: string): unknown; readonly primary?: string; has(role: string): boolean; get(role: string): { binding: { capability: { provider: string; id: string } } } }
    /** Which containment tier actually built the box. Reported, never assumed. */
    tier: "none" | "auto" | "container" | "hardened"
    /**
     * The AGENT process's pid — what a liveness probe checks.
     *
     * Not the supervisor's: a reader uses this to decide whether the session
     * is still alive, and reporting the wrong one would keep a dead agent
     * looking healthy for as long as its supervisor outlived it.
     */
    pid: number
    reload(): Promise<void>
    shutdown(): Promise<void>
}

/**
 * An agent — always its own process, reached over the link.
 *
 * Was a discriminated union while an in-heap variant still existed. There is
 * one kind now, so consumers reach the link directly instead of narrowing.
 */
export type AgentT = Awaited<ReturnType<typeof Agent>>

