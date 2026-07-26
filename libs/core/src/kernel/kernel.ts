import { err } from "@axon/err"
import type { AxonBlueprint, AxonEntry, AxonEventMap, AxonRunResult, KernelAbi } from "@arcforge/types"
import type { AxonCloudClient } from "../../../../cloud/src"
import type { AxonBusT } from "../platform/bus"
import { Engine } from "./engine"
import type { AxonSessionT } from "./session"
import { AxonCapsule, type AxonCapsuleT } from "./capsule"
import { Scheduler } from "./scheduler"
import type { CognetT } from "../cognet/cognet"
import { Boot } from "./boot"
import { Store } from "./store"
import type { AxonHost } from "../Axon"

type KernelOpts = {
    blueprint: AxonBlueprint
    /** Immutable host invocation directory for this runtime's userland. */
    cwd: string
    bus: AxonBusT
    /** The runtime's cloud client — engines resolve vault-backed provider tokens through it. */
    cloud: AxonCloudClient
    /** The brain — the runtime's handle over the blueprint-carried cognet artifact. Always present. */
    cognet: CognetT
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

    const boot = Boot({
        blueprint: opts.blueprint,
        session: session,
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
            // Same TS limitation as emit() below: AxonEntryEvent is an
            // intersection containing AxonOutputEvent — TS can't distribute
            // an indexed access over it for a generic key, but the payload
            // type is identical for every K. Not a shape mismatch.
            return session.commitEntry(type as never, data as never, run).then(() => {})
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
        base: async () => (await boot.render()) ?? "", // absent boot → "", never undefined

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
            void session.commit(type, data as AxonEventMap[typeof type], scheduler.current() ?? undefined)
        },

        // persistence surface — private cognitive state + read-only episodic
        // access, one mediated door like stream/run (see Store())
        store: store,
    }

    // exec(): the kernel is the only loader. ABI compatibility is checked
    // inside the handle; a mismatched artifact never half-loads.
    await cognet.load(abi)
    scheduler.attach(cognet)

    return {
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
            boot.update(next)
            await cognet.update(next)
            await capsule.update(next) // new policy → rebuilt sandbox, live before old drops
        },

        /**
         * Drain the mind: abort any wake, stop the scheduler's clock (if
         * continuous), unload the brain, kill the userland. Session is not
         * kernel's to close — AxonRuntime.shutdown() ends it after this
         * resolves, so a failure here never skips flushing the log.
         */
        async shutdown() {
            scheduler.interrupt("shutdown")
            scheduler.stop()
            await cognet.unload()
            await capsule.shutdown()
        },
    }
}

export type AxonKernelT = Awaited<ReturnType<typeof Kernel>>
