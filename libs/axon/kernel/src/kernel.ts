import { err } from "@arcforge/err"
import type { AxonBlueprint, AxonEntry, AxonEntryEvent, AxonEventMap, AxonRunResult, KernelAbi } from "@arcforge/types"
import type { AxonCloudClient } from "@arclabs/cloud"
import type { KernelBus } from "./contracts"
import { Engine } from "./engine"
import type { AxonSessionT } from "@arcforge/session"
import { AxonCapsule, type AxonCapsuleT } from "./capsule"
import { Scheduler } from "./scheduler"
import type { KernelCognet } from "./contracts"
import { Store } from "./store"
import type { AxonHost } from "@arcforge/types"

type KernelOpts = {
    blueprint: AxonBlueprint
    /** Immutable host invocation directory for this runtime's userland. */
    cwd: string
    bus: KernelBus
    /** The runtime's cloud client — engines resolve vault-backed provider tokens through it. */
    cloud: AxonCloudClient
    /** The brain — the runtime's handle over the blueprint-carried cognet artifact. Always present. */
    cognet: KernelCognet
    /**
     * The session is environmental — constructed once at the Axon() seam,
     * alongside bus/cloud, and handed to every consumer that needs it
     * (Kernel, AxonRuntime, AxonHandle). Kernel does not own it and does
     * not close it; it only reaches session through the ABI's output()/
     * run(), which is the one real privilege boundary this file enforces
     * (the untrusted cognet may only emit/request, never read or write the
     * log directly). No thread concept: one cognet instance is always
     * exactly one continuous stream.
     */
    session: AxonSessionT
    /**
     * The agent's base identity text, rendered fresh per call — backs the
     * ABI's base(). Injected because rendering it is a PRESENTATION concern
     * (boot.vue, the vstr renderer, the prompt context) that ring 0 has no
     * business owning: the kernel guards the user's identity contract, it
     * does not decide how that identity is produced.
     */
    base: () => Promise<string>
    /**
     * Re-render base() against a new blueprint on reload. Paired with `base`:
     * whoever owns producing the identity text owns refreshing it, so ring 0
     * fans the blueprint out without knowing what produces it.
     */
    onUpdate?: (blueprint: AxonBlueprint) => void
    host?: AxonHost
}

type KernelInput = {
    /** User message committed before the wake starts. */
    content?: string | string[]
}

const COGNET_EVENT_PREFIX = "cognet:"

/** Render a run's completion value for the visible tool-call log. Strings pass through; everything else is JSON. */
function formatValue(value: unknown): string {
    if (value === undefined) return ""
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value, null, 2) ?? ""
    } catch {
        return String(value)
    }
}

/**
 * Run one block against the capsule and normalize the outcome — the ABI
 * boundary this seam exists for. Exec() below (capsule's own contract)
 * still rejects; a program should never have to catch three different
 * shapes (AbortError, timeout Error, plain Error) to know what happened,
 * so this is the one place that catch lives. Console output is captured
 * here too (via the capsule's own onConsole, never exposed past this
 * function) and returned inline — the kernel already auto-forwards the
 * capsule's full event stream to the bus untranslated, so a program that
 * wants live output subscribes to that; a program that wants ITS OWN run's
 * output back as part of the result reads `stdout` here, no callback wired
 * by hand.
 */
async function runOne(capsule: AxonCapsuleT, code: string, opts?: { signal?: AbortSignal; id?: string }): Promise<AxonRunResult> {
    const stdout: string[] = []
    const onConsole = (level: string, args: unknown[]) => {
        const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
        stdout.push(level === "log" || level === "info" ? line : `[${level}] ${line}`)
    }

    try {
        const value = await capsule.current.run(code, { onConsole, signal: opts?.signal, id: opts?.id })
        return { ok: true, value, stdout }
    } catch (cause) {
        const interrupted = opts?.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")
        const timedOut = cause instanceof Error && /timed out/.test(cause.message)
        return {
            ok: false,
            stdout,
            error: {
                kind: interrupted ? "interrupt" : timedOut ? "timeout" : "exception",
                message: cause instanceof Error ? cause.message : String(cause),
            },
        }
    }
}

/**
 * Kernel — the agent's OS. Owns resources and execution, never cognition.
 *
 * Ring 0: the trusted machinery — engine (inference), scheduler (process
 * management), the capsule's constructor. Ring 3: the capsule — the
 * unprivileged userland every agent-emitted effect runs in; the kernel is
 * its ONLY constructor, and security is enforced at that process boundary
 * alone.
 *
 * Session is NOT kernel-owned — it's environmental, constructed once at
 * the Axon() seam and handed in here like bus/cloud. The kernel's only
 * relationship to it is mediating the cognet's access: the ABI's output()
 * and run() are the only doors, and both commit on the cognet's behalf —
 * it never touches session.commit directly. Every other consumer (Axon(),
 * AxonRuntime, AxonHandle) reaches session directly — going through the
 * kernel to commit a runtime event was the original design mistake this
 * replaces.
 *
 * Cognition lives in the COGNET — a versioned artifact carried in on the
 * blueprint, exec'd here once, and woken per stimulus (or per tick, for a
 * continuous-mode cognet — see scheduler/). The cognet touches nothing but
 * the ABI built here; the kernel never learns what the model sees or how
 * the brain thinks. Grammar, rendering, strategy: all above this line's
 * pay grade. No thread concept anywhere in this file: one cognet instance
 * is always exactly one continuous stream against the session's one log;
 * multiple independent conversations are multiple Axon() instances, a
 * host-level (TUI) concern this file has no opinion on.
 *
 * The kernel exists to protect user resources from the cognet. The cognet
 * is the unprivileged brain that uses the user's resources as per policy.
 */
export async function Kernel(opts: KernelOpts) {
    const cognet = opts.cognet
    const session = opts.session

    const scheduler = Scheduler({
        bus: opts.bus,
        session: session,
    })

    const capsule = await AxonCapsule({
        boot: true,
        blueprint: opts.blueprint,
        bus: opts.bus,
        session: session,
        run: () => scheduler.current(),
        cwd: opts.cwd,
        ...(opts.host ? { host: opts.host } : {}),
    })

    const engine = Engine({
        blueprint: opts.blueprint,
        session,
        cloud: opts.cloud,
    })

    const store = Store({
        blueprint: opts.blueprint,
        cognet: cognet,
        session: session,
    })

    /** One block or many (concurrent, Promise.all-shaped) — always resolves. */
    function run(code: string, runOpts?: { signal?: AbortSignal }): Promise<AxonRunResult>
    function run(code: string[], runOpts?: { signal?: AbortSignal }): Promise<AxonRunResult[]>
    function run(code: string | string[], runOpts?: { signal?: AbortSignal }): Promise<AxonRunResult> | Promise<AxonRunResult[]> {
        if (Array.isArray(code)) return Promise.all(code.map(c => runOne(capsule, c, runOpts)))
        return runOne(capsule, code, runOpts)
    }

    /**
     * The ABI's own run() — same normalized result as the script-facing
     * run() above, plus one more step: durably commits cognet:action:typescript
     * (the code) and cognet:action:result (the outcome) to the session's one log,
     * the moment each block settles. This is the platform-owned half of
     * the two-verb rule — the cognet never calls session.commit itself; it
     * just reads the returned result for its own control flow.
     */
    async function runAndCommit(code: string, runOpts?: { signal?: AbortSignal }): Promise<AxonRunResult> {
        const run = scheduler.active() // throws SYSCALL_OUTSIDE_RUN if no wake is running
        const id = Bun.randomUUIDv7()
        await session.commitEntry("cognet:action:typescript", { id, content: code }, run)
        // The entry id IS the capsule command id — one id for one execution,
        // so capsule:cmd/fn/activity spans join the visible tool call directly.
        const result = await runOne(capsule, code, { ...runOpts, id })
        await session.commitEntry("cognet:action:result", {
            for: id,
            ok: result.ok,
            content: [...result.stdout, result.ok ? formatValue(result.value) : ""].filter(s => s.length > 0).join("\n"),
            ...(result.error ? { error: result.error } : {}),
        }, run)
        return result
    }

    // ── the ABI — the syscall table, bound once to the kernel's organs ──────
    // Process-lifetime object: nothing on it carries per-wake state beyond
    // what scheduler.active() resolves internally. This is the only thing
    // a program ever holds.
    const abi: KernelAbi = {
        /** unmediated — commits directly to the session's one log, never refuses */
        output: (type, data) => {
            const run = scheduler.active() // throws SYSCALL_OUTSIDE_RUN if no wake is running
            // AxonEntryEvent is an intersection that CONTAINS AxonOutputEvent,
            // so for any output key the two payload types are the same type —
            // TS can't prove it through the intersection for a generic K. The
            // TYPE is now fully checked (it was `as never` before, checking
            // nothing); only the payload's provenance needs asserting, and
            // it's asserted at this one key, not across the union.
            return session.commitEntry(type, data as AxonEntryEvent[typeof type], run).then(() => {})
        },

        // llm surface
        stream: (req) => engine.stream(req, scheduler.active()),

        // capsule surface — self-committing (see runAndCommit above)
        run: ((code: string | string[], runOpts?: { signal?: AbortSignal }) => {
            if (Array.isArray(code)) return Promise.all(code.map(c => runAndCommit(c, runOpts)))
            return runAndCommit(code, runOpts)
        }) as KernelAbi["run"],
        scope: () => capsule.current.scope,

        // environment surface
        base: opts.base,

        /**
         * Cognet telemetry — enforced at the call site, not just the type:
         * the cognet's own `emit<K extends keyof CognetEventMap>` signature
         * already prevents a well-typed call from naming anything outside
         * cognet:*, but nothing stopped a raw/untyped call from reaching the
         * write path under any string. Refusing loudly here closes that gap —
         * a cognet can narrate its own world, never forge kernel machinery.
         *
         * Durable: commits to the session's log (which forwards to the bus
         * after the append lands), same pipeline as every other event — the
         * cognet's telemetry is debugging record, and a log it never reaches
         * is a log that can't debug it. Fire-and-forget for the cognet
         * (emit stays sync/void); a continuous-mode cognet ticking fast will
         * make this chatty — the known cost, gate at the write if it bites.
         */
        emit: (type, data) => {
            if (!(type as string).startsWith(COGNET_EVENT_PREFIX)) {
                throw err("COGNET_EMIT_FORBIDDEN", { detail: `cognet may only emit cognet:* events, got "${type as string}"`, context: { type: type as string } })
            }
            // runId when a wake is running, bare outside one (load/unload
            // narration is legal) — current() never throws, unlike active().
            //
            // The catch is required, not defensive: emit() is sync by
            // contract (the cognet never awaits its own telemetry), so a
            // rejected commit has nowhere to go. Without it a disk failure
            // during a fast-ticking wake would surface as an unhandled
            // rejection and kill the runtime — a telemetry write must never
            // be able to take down the thing it is observing.
            void session
                .commit(type, data as AxonEventMap[typeof type], scheduler.current() ?? undefined)
                .catch(() => {})
        },

        // persistence surface — private cognitive state + read-only episodic
        // access, one mediated door like stream/run (see Store())
        store: store,

        // The brain's own rhythm. Called from a cognet plugin, never from the
        // body — see KernelAbi.wake for why the body must not drive this.
        // Deliberately NOT awaited into the wake: admission is the contract,
        // so a driver on an interval never serialises the overlap.
        wake: () => scheduler.wake(),

        clock: () => scheduler.clock(),

        // Resolved at prepare and carried on the blueprint — the runtime only
        // hands the paths over. Frozen so a brain cannot mutate the map it
        // was given, and empty (never undefined) so a cognet reads it without
        // branching.
        models: Object.freeze({ ...(opts.blueprint.cognet.models ?? {}) }),
    }

    // exec(): the kernel is the only loader. ABI compatibility is checked
    // inside the handle; a mismatched artifact never half-loads.
    //
    // The kernel owns this bracket rather than the cognet: exec'ing an
    // untrusted artifact is boot's most failure-prone step, and a brain that
    // dies inside load() could never close a bracket it opened itself.
    const loadStarted = Date.now()
    await session.commit("cognet:load:start", { name: cognet.name })
    try {
        await cognet.load(abi)
    } catch (cause) {
        const failure = err(cause)
        await session.commit("cognet:load:failed", { name: cognet.name, error: failure, durationMs: Date.now() - loadStarted })
        throw failure
    }
    await session.commit("cognet:load:complete", { name: cognet.name, durationMs: Date.now() - loadStarted })
    scheduler.attach(cognet)

    return {
        /**
         * Whether a cognet is loaded and able to wake.
         *
         * False after a failed load or a reload whose new brain did not
         * compile: the process is alive and serving HTTP, but there is
         * nothing to think with. An agent in that state must not report
         * itself healthy — it looks fine from outside while silently
         * answering nothing.
         */
        get ready() {
            return scheduler.loaded
        },

        /** Invoke on a stimulus arrival — invocation-mode cognets only; throws for continuous-mode. */
        stream(input: KernelInput = {}) {
            return scheduler.stream(input)
        },

        /** Collect a full wake: every durable entry, in commit order. */
        async request(input: KernelInput = {}): Promise<{ ok: true; entries: AxonEntry[] }> {
            const entries: AxonEntry[] = []
            for await (const entry of scheduler.stream(input).stream) {
                entries.push(entry) // the wire carries entries, full stop — chunks included
            }
            return { ok: true, entries }
        },

        // No tick() on the public surface. The brain drives its own rhythm
        // through the ABI (KernelAbi.tick, called from a cognet plugin) —
        // exposing it here would let the body wake a mind it knows nothing
        // about, which is the coupling this split exists to remove.

        /** Abort the active wake, if any. Safe to call when idle. */
        interrupt(reason: "user" | "shutdown" = "user") {
            scheduler.interrupt(reason)
        },

        /**
         * Execute code in the capsule directly — the same conversation an
         * agent-generated <typescript> block gets, mediated by the same
         * policy and the same normalized result. Backs axon.tools.* proxy
         * calls from script-land; the kernel is the only capsule
         * constructor, so callers reach it here, never by holding the
         * capsule handle themselves.
         */
        run,

        /**
         * The capsule's process tree, live: `main` is the sandboxed TS
         * runtime itself, `processes` its managed children (everything the
         * agent has spawned). Read/observe surface for clients (the TUI's
         * capsule tree); the kernel remains the only constructor.
         */
        get userland() {
            return {
                main: capsule.current.main,
                processes: capsule.current.process.list(),
            }
        },

        /**
         * The agent changed: one entry point, fanned out to the organs.
         * Receives the full re-normalized blueprint from the runtime.
         */
        async update(next: AxonBlueprint) {
            engine.update(next)
            opts.onUpdate?.(next)
            await cognet.update(next)
            await capsule.update(next) // new policy → rebuilt sandbox, live before old drops
        },

        /**
         * Drain the mind: abort any wake, unload the brain, kill the
         * userland. Session is not kernel's to close — AxonRuntime.shutdown()
         * ends it after this resolves, so a failure here never skips flushing
         * the log.
         *
         * No clock to stop: a continuous cognet is ticked by the body (a
         * plugin driving `axon.tick()`), which tears its own interval down on
         * `shutdown:before` — before this runs.
         */
        async shutdown() {
            scheduler.interrupt("shutdown")

            // A failed unload must never strand the userland: the capsule is
            // a real OS process, and skipping its teardown leaks it for the
            // life of the host. The brain's failure is recorded, then
            // rethrown after the box is definitely gone.
            const unloadStarted = Date.now()
            await session.commit("cognet:unload:start", { name: cognet.name })
            // Before the unload, not after: whether it succeeds or throws, a
            // brain being torn down can no longer wake, and readiness must
            // stop claiming otherwise the moment that becomes true.
            scheduler.detach()
            let failure: ReturnType<typeof err> | null = null
            try {
                await cognet.unload()
                await session.commit("cognet:unload:complete", { name: cognet.name, durationMs: Date.now() - unloadStarted })
            } catch (cause) {
                failure = err(cause)
                await session.commit("cognet:unload:failed", { name: cognet.name, error: failure, durationMs: Date.now() - unloadStarted })
            }

            await capsule.shutdown()
            if (failure) throw failure
        },
    }
}

export type AxonKernelT = Awaited<ReturnType<typeof Kernel>>
