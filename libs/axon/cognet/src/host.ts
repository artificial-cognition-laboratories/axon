import { Hookable } from "hookable"
import { effects } from "./effects"
import { AsyncLocalStorage } from "node:async_hooks"
import { Gate, Typed } from "./services"
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { err } from "@arcforge/err"
import type { AxonRunResult, CognetConfig, CognetIdentity, CognetDefinition, CognetHooks, CognetPlugin, CognetWake, KernelAbi } from "@arcforge/types"
import type { AxonOutputEvent } from "@arcforge/types"
import { Clock } from "./clock"
import { Ticks } from "./ticks"
import { component, Ecs, frame, query, type EcsT } from "./ecs"
import { clock as passing, defineSystem, Schedule, stimuli, type NamedSystem, type ScheduleT } from "./schedule"
import { Pulse, type PulseT } from "./pulse"
import { MARK, Serve, Threads, type ThreadsT } from "./threads"

/**
 * CognetHost — the runtime half of the cognet authoring surface.
 *
 * A cognet is authored as plain files against ambient globals:
 *   cognet.config.ts — what the brain declares: `defineCognet({ mode, ... })`
 *   <any>.system.ts  — SYSTEMS, discovered wherever they sit. The host runs
 *                      them every tick, in the order their data demands.
 *   main.ts          — OPTIONAL. A raw script that may declare `loop(...)`,
 *                      run after the systems on every tick.
 *   plugins/*.ts     — lifecycle hooks: boot, wake, tick, shutdown.
 *
 * The CLI compile step wraps main.ts in a callable, names every component and
 * query from where it is defined, and generates an entry composing this host
 * with the config and the systems — so the desugared form is an ordinary
 * CognetDefinition against the ABI, with no side channel around it.
 *
 * IMPORTING THIS MODULE INSTALLS THE GLOBALS (that's why it is not exported
 * from the cognet index — only generated bundle entries import it, first,
 * so config/main evaluate with the globals present). One brain per process;
 * each bundle carries its own inlined copy of this module's state.
 *
 * Global rules:
 * - process-lifetime things are ambient (kernel, ecs, loop, component,
 *   query, frame, defineSystem)
 * - the cognet learns NOTHING about its environment: no blueprint, no config,
 *   no paths. A mind that never knew what kind of world it was in doesn't
 *   need porting when the world changes.
 * - wake-scoped things arrive as loop-body ARGS (stop, stimuli, signal,
 *   push); phase/system are ambient sugar bound to the current wake's
 *   world through AsyncLocalStorage. Several Axon instances share one JS
 *   global object, so plain global assignment is not an isolation boundary.
 */

type LoopCtx = CognetWake & {
    /** end the wake after this tick completes — the brain stays warm */
    stop(): void
}

type LoopBody = (ctx: LoopCtx) => Promise<void>

// ── host state (module-scoped: one copy per compiled bundle) ────────────────

let registered: LoopBody | null = null
let boundKernel: KernelAbi | null = null
let loaded = false
/** Built at the first wake from the systems the compile step discovered. Null when there are none. */
let schedule: ScheduleT | null = null
/** A continuous mind's clock, running between boot and unload. */
let pulse: PulseT | null = null
/** The worker threads, when a system asks for one. Built with the schedule, closed at unload. */
let threads: ThreadsT | null = null
/** The systems CognetHost was given — what a worker thread looks jobs up in. */
let hosted: readonly NamedSystem[] | null = null

/**
 * This bundle, loaded again as a worker thread (see ./threads). It evaluates
 * exactly as on the main thread — same handles, same names, same systems —
 * and then answers jobs instead of being loaded by a kernel.
 */
const onWorker = !isMainThread && (workerData as Record<string, unknown> | null)?.[MARK] === true

type CognetAmbientScope = {
    kernel: KernelAbi
    loop(body: LoopBody): void
    phase<T>(name: string, fn: () => Promise<T>): Promise<T>
    system<T>(name: string, fn: () => Promise<T>): Promise<T>
    /**
     * The clock of the wake this async context belongs to.
     *
     * Carried in the scope rather than a module-level `currentClock`, because
     * that single mutable assumed one wake existed at a time. A continuous
     * cognet ticks whether or not the previous wake finished, so two bodies
     * overlap routinely: the second assigned `currentClock`, the first's
     * phase() then timed against the wrong clock, and whichever finished
     * first set it null — leaving the other to throw mid-flight. Every
     * symptom silent, and all of it invisible until a wake outlived a tick.
     *
     * Null outside a wake (load, shutdown), where phase() is illegal anyway.
     */
    clock: ReturnType<typeof Clock> | null
    /** The moment the wake stands for, when it was given one (a replay); null for a live wake, which is now. */
    at: number | null
}

// Every compiled cognet carries an inlined copy of this module, but all of
// those copies execute in the same process/globalThis. Symbol.for gives them
// one dispatcher while AsyncLocalStorage keeps nested and concurrent wakes
// bound to their own runtime across awaits.
const AMBIENT_SCOPE = Symbol.for("axon.cognet.ambient-scope")
const ambientStorage = (() => {
    const shared = globalThis as typeof globalThis & { [AMBIENT_SCOPE]?: AsyncLocalStorage<CognetAmbientScope> }
    return shared[AMBIENT_SCOPE] ??= new AsyncLocalStorage<CognetAmbientScope>()
})()

function ambientOrThrow(): CognetAmbientScope {
    const scope = ambientStorage.getStore()
    if (!scope && onWorker) throw err("COGNET_WORKER_FAILED", { detail: "a worker thread has no kernel, loop, phase or system — a thread: \"worker\" system reads and writes the world and nothing else" })
    if (!scope) throw err("COGNET_ACCESSED_BEFORE_LOAD", { detail: "cognet globals are only available inside this brain's load, wake, and shutdown scope" })
    return scope
}

// The cognet's own lifecycle hooks — a SEPARATE hookable from Axon's, one
// ring down. The kernel drives the brain's life through the host; the host
// fires these at the four fixed points. Awaited-to-completion, in order.
const hooks = new Hookable<CognetHooks>()

function kernelOrThrow(): KernelAbi {
    if (!boundKernel && onWorker) throw err("COGNET_WORKER_FAILED", { detail: "a worker thread has no kernel — a thread: \"worker\" system reads and writes the world and nothing else" })
    if (!boundKernel) throw err("COGNET_ACCESSED_BEFORE_LOAD", { detail: "kernel is not available yet — it binds at load(); do work inside loop(), not at module top level" })
    return boundKernel
}

function clockOrThrow(): ReturnType<typeof Clock> {
    const clock = ambientStorage.getStore()?.clock
    if (!clock) throw err("COGNET_ACCESSED_BEFORE_LOAD", { detail: "phase()/system() are wake-scoped — call them inside the loop body" })
    return clock
}

// ── the cognet's own lifetime state ─────────────────────────────────────────

/**
 * The tick counter, and the world.
 *
 * Both outlive every wake, for the same reason. A continuous cognet's wake IS
 * one tick, so anything scoped to a wake is scoped to a single instant: the
 * counter would never pass 1, and a world would be discarded twenty times a
 * second, taking every decaying drive and remembered place with it.
 *
 * The world is built lazily, on first touch of the `ecs` global, so a cognet
 * that never queries an entity carries no entity store — which is the opt-in
 * property the subpath export was protecting.
 */
const ticks = Ticks()

let world: EcsT | null = null

function worldOrCreate(): EcsT {
    return world ??= Ecs({
        emit: (type, data) => kernelOrThrow().emit(type, data),
        // A write outside a wake — boot-time spawning — has a real tick and no
        // phase or system. Reading the clock at write time rather than
        // capturing one is what lets one world serve overlapping wakes.
        stamp: () => {
            const clock = ambientStorage.getStore()?.clock
            if (!clock) return { tick: ticks.current(), phase: null, system: null }
            return clock.stamp()
        },
        // The time a write is made at: the wake's own when it was given one (a replay), else now.
        now: () => ambientStorage.getStore()?.at ?? Date.now(),
    })
}

// ── ambient globals ──────────────────────────────────────────────────────────

const globals = globalThis as Record<string, unknown>

globals.defineCognet = <T extends CognetConfig>(config: T): T => config

// The authoring surface for systems. Handles are created at import time,
// before any world exists; the generated entry names them from where they
// are defined. See ./ecs/handle.ts and ./discovered.ts.
globals.component = component
globals.query = query
globals.frame = frame
globals.defineSystem = defineSystem
globals.stimuli = stimuli
globals.clock = passing

function registerLoop(body: LoopBody): void {
    if (registered) throw err("COGNET_LOOP_ALREADY_DECLARED")
    registered = body
}

// definePlugin — plumbing wired to lifecycle hooks. Runs at import time
// (the compile step imports plugins/*.ts into the bundle after this module),
// so a plugin's hooks.on(...) registrations land before load() fires "boot".
globals.definePlugin = (plugin: CognetPlugin): CognetPlugin => {
    // hookable's InferCallback can't distribute over the generic hook name,
    // so the handler is passed through — CognetPluginContext already typed it
    // correctly at the call site; this is a TS limitation, not a shape gap.
    plugin({ hooks: { on: (name, fn) => hooks.hook(name, fn as never) } })
    return plugin
}

// run() is overloaded on input shape (string vs string[]) — a plain arrow
// can't carry two call signatures, so it's declared separately and spread in.
function run(code: string): Promise<AxonRunResult>
function run(code: string[]): Promise<AxonRunResult[]>
function run(code: string | string[]) {
    if (Array.isArray(code)) return kernelOrThrow().run(code)
    return kernelOrThrow().run(code)
}

/**
 * The `engine` verb, delegating like every other syscall.
 *
 * A FACADE rather than a captured reference, for the same reason the rest of
 * this table delegates: the bound ABI is resolved at the moment a call is
 * made, never at module scope, so nothing here can outlive or precede a
 * load(). Written twice-over as one helper because the two facades below
 * (bound-kernel and ambient) differ only in how they reach the ABI.
 *
 * `has` hangs off the callable so the common case reads as one verb and the
 * degradation check reads as a question — which is the shape the ABI
 * declares, and a shim that flattened it would quietly change the contract.
 */
function engineFacade(resolve: () => KernelAbi): KernelAbi["engine"] {
    return Object.assign(
        (role: string) => resolve().engine(role),
        { has: (role: string) => resolve().engine.has(role) },
    )
}

/** The services, delegated per call to whichever kernel `resolve` finds — never captured before load(). */
function servicesFacade(resolve: () => KernelAbi): KernelAbi["services"] {
    return {
        state: () => resolve().services.state(),
        call: (use, method, args, signal) => resolve().services.call(use, method, args, signal),
        stream: (use, method, args, signal) => resolve().services.stream(use, method, args, signal),
        open: (use, method) => resolve().services.open(use, method),
        push: (session, value) => resolve().services.push(session, value),
        reset: session => resolve().services.reset(session),
        close: session => resolve().services.close(session),
        release: handle => resolve().services.release(handle),
    }
}

// the syscall table, delegating — live from load() onward
const localKernel = {
    // Effects go through `effects`: held while a sync run is running, made when it lands.
    output: (type: keyof AxonOutputEvent, data: never) => effects.send(() => kernelOrThrow().output(type, data)),
    engine: engineFacade(() => kernelOrThrow()),
    services: servicesFacade(() => kernelOrThrow()),
    run,
    scope: () => kernelOrThrow().scope(),
    body: () => kernelOrThrow().body(),
    presence: () => kernelOrThrow().presence(),
    base: () => kernelOrThrow().base(),
    emit: (type: never, data: never) => void effects.send(() => kernelOrThrow().emit(type, data)),
    fault: (input: Parameters<KernelAbi["fault"]>[0]) => effects.send(() => kernelOrThrow().fault(input)),
    // store is a live sub-object on the bound ABI — delegate per call, same
    // discipline as every other syscall (never captured before load())
    store: {
        session: {
            get: (opts?: { after?: number }) => kernelOrThrow().store.session.get(opts),
        },
        get: (key: never) => kernelOrThrow().store.get(key),
        set: (key: never, value: never) => kernelOrThrow().store.set(key, value),
    },
    // Same discipline as store: a live sub-object on the bound ABI,
    // delegated per call and never captured before load().
    knowledge: {
        list: (opts?: Parameters<KernelAbi["knowledge"]["list"]>[0]) => kernelOrThrow().knowledge.list(opts),
        read: (name: string) => kernelOrThrow().knowledge.read(name),
        write: (name: string, content: string) => kernelOrThrow().knowledge.write(name, content),
        remove: (name: string) => kernelOrThrow().knowledge.remove(name),
    },
    memory: {
        connect: (name: string) => kernelOrThrow().memory.connect(name),
    },
    wake: () => kernelOrThrow().wake(),
    clock: () => kernelOrThrow().clock(),
    // A getter, not a captured value: the bound kernel arrives at load(), and
    // capturing this at module scope would freeze an empty map from before
    // the brain was given anything.
} satisfies KernelAbi

/**
 * The ambient scope for one execution. Everything in it is shared except the
 * clock, which belongs to the wake that created it — see CognetAmbientScope.
 *
 * A function rather than a singleton: concurrent wakes each need their own
 * store, and `ambientStorage.run(sharedObject, ...)` would have given them
 * one object to fight over.
 */
function scopeFor(clock: ReturnType<typeof Clock> | null, at: number | null): CognetAmbientScope {
    return {
        kernel: localKernel,
        loop: registerLoop,
        phase: <T>(name: string, fn: () => Promise<T>) => clockOrThrow().runPhase(name, fn),
        system: <T>(name: string, fn: () => Promise<T>) => clockOrThrow().runSystem(name, fn),
        clock: clock,
        at: at,
    }
}

/** Load, boot and shutdown run outside any wake, so they carry no clock. */
const localScope: CognetAmbientScope = scopeFor(null, null)

// Stable process-wide facades. They never capture one cognet instance; every
// operation resolves the current async scope at the moment it is performed.
globals.loop = (body: LoopBody): void => ambientOrThrow().loop(body)
globals.kernel = {
    output: (type: keyof AxonOutputEvent, data: never) => ambientOrThrow().kernel.output(type, data),
    engine: engineFacade(() => ambientOrThrow().kernel),
    services: servicesFacade(() => ambientOrThrow().kernel),
    run: ((code: string | string[]) => ambientOrThrow().kernel.run(code as never)) as KernelAbi["run"],
    scope: () => ambientOrThrow().kernel.scope(),
    body: () => ambientOrThrow().kernel.body(),
    presence: () => ambientOrThrow().kernel.presence(),
    base: () => ambientOrThrow().kernel.base(),
    emit: (type: never, data: never) => ambientOrThrow().kernel.emit(type, data),
    fault: (input: Parameters<KernelAbi["fault"]>[0]) => ambientOrThrow().kernel.fault(input),
    store: {
        session: { get: (opts?: { after?: number }) => ambientOrThrow().kernel.store.session.get(opts) },
        get: (key: never) => ambientOrThrow().kernel.store.get(key),
        set: (key: never, value: never) => ambientOrThrow().kernel.store.set(key, value),
    },
    knowledge: {
        list: (opts?: Parameters<KernelAbi["knowledge"]["list"]>[0]) => ambientOrThrow().kernel.knowledge.list(opts),
        read: (name: string) => ambientOrThrow().kernel.knowledge.read(name),
        write: (name: string, content: string) => ambientOrThrow().kernel.knowledge.write(name, content),
        remove: (name: string) => ambientOrThrow().kernel.knowledge.remove(name),
    },
    memory: {
        connect: (name: string) => ambientOrThrow().kernel.memory.connect(name),
    },
    // Resolved through kernelOrThrow(), not ambientOrThrow(): a plugin's
    // clock lives in a setInterval registered during boot, and that callback
    // fires outside every ambient scope. The bound kernel is module state
    // that outlives each wake, which is exactly what a driver needs.
    wake: () => kernelOrThrow().wake(),
    clock: () => kernelOrThrow().clock(),
} satisfies KernelAbi

globals.phase = <T>(name: string, fn: () => Promise<T>) => ambientOrThrow().phase(name, fn)
globals.system = <T>(name: string, fn: () => Promise<T>) => ambientOrThrow().system(name, fn)

// The world. A facade rather than the handle itself, so the store is built on
// first use and every operation reaches the one world this cognet owns.
globals.ecs = {
    get state() { return worldOrCreate().state },
    get schema() { return worldOrCreate().schema },
    get entity() { return worldOrCreate().entity },
    get component() { return worldOrCreate().component },
    query: ((select: never) => worldOrCreate().query(select)) as EcsT["query"],
    set: (...args: Parameters<EcsT["set"]>) => worldOrCreate().set(...args),
    watch: (...args: Parameters<EcsT["watch"]>) => worldOrCreate().watch(...args),
    observe: <T>(fn: () => T) => worldOrCreate().observe(fn),
    isolate: (...args: Parameters<EcsT["isolate"]>) => worldOrCreate().isolate(...args),
    apply: (...args: Parameters<EcsT["apply"]>) => worldOrCreate().apply(...args),
} satisfies EcsT

// ── composition (what the generated entry calls) ────────────────────────────

/**
 * What the generated entry hands the host: the resolved config, plus every
 * system the compile step discovered, already named (see Discovered()).
 */
export type CognetHostConfig = CognetIdentity & {
    systems?: readonly NamedSystem[]
}

/**
 * config + wrapped main → the definition the kernel loads. main() runs once
 * at load(), with kernel already bound — its module/closure scope is the
 * brain's resident RAM. It may declare one loop(); a brain made only of
 * systems declares none.
 *
 * `config` here is NOT the author's cognet.config.ts. The compile step builds
 * it: the author's declarations (mode, wakeOn, engines) merged with identity
 * it resolved itself — name and version from the cognet's package.json, the
 * ABI from the kernel it compiled against unless the config pinned one. The
 * author writes none of those three, which is why CognetConfig no longer has
 * a place to put them.
 *
 * Deliberately still TWO arguments. This is a published package's public
 * surface, and a compiled bundle inlines whichever copy of it the agent has
 * installed. Widening the signature would mean a new CLI emitting a call an
 * older installed host cannot answer — the arguments shift by one, `main`
 * lands in `config`, and the brain dies at load() calling an object. Passing
 * identity through the object keeps old and new hosts compatible with both
 * old and new entries.
 */
export function CognetHost(config: CognetHostConfig, main: () => Promise<void>): CognetDefinition {
    const systems = config.systems ?? []
    hosted = systems

    return {
        ...config,

        async load(abi) {
            // A definition is a process-lifetime artifact. Reload plumbing may
            // encounter the same hash-busted module instance again; exec is
            // idempotent for that instance and must never register main twice.
            if (loaded) {
                if (boundKernel !== abi) throw err("COGNET_ALREADY_LOADED", { context: { name: config.name } })
                return
            }
            boundKernel = abi
            try {
                // The brain's own code, running for the first time. Anything
                // it throws is classified HERE rather than escaping raw: a
                // cognet is authored source, so an uncoded throw from it is
                // the ORDINARY case, and letting it surface as an
                // unclassified error told the author only that something
                // failed somewhere. The cause is preserved — this names the
                // boundary the failure crossed, it does not replace it.
                try {
                    await ambientStorage.run(localScope, main) // declares loop(); plugins already registered at import time
                } catch (cause) {
                    throw err("COGNET_LOAD_FAILED", { cause, context: { name: config.name, version: config.version } })
                }
                if (!registered && systems.length === 0) {
                    throw err("COGNET_NO_LOOP", { detail: `${config.name} declares no loop() and has no *.system.ts files`, context: { name: config.name } })
                }
                // A mind is systems or a loop. Its schedule owns its ticks —
                // opens them, merges wakes into them — and a loop body run
                // once per wake beside that would have no tick of its own.
                if (registered && systems.length > 0) {
                    throw err("COGNET_SCHEDULE_INVALID", { detail: `${config.name} declares a loop() and has ${systems.length} systems — a mind with systems is its systems; move what the loop does into one`, context: { name: config.name } })
                }
                // Built BEFORE boot so an invalid rate refuses the load
                // outright; STARTED after it, so no wake runs systems against
                // plugins that have not set up.
                pulse = config.mode.kind === "continuous"
                    ? Pulse({
                        hz: config.mode.hz,
                        wake: () => kernelOrThrow().wake(),
                        refused: cause => kernelOrThrow().emit("cognet:log:error", {
                            value: `${config.name}: the kernel refused a wake, so the clock stopped — ${cause instanceof Error ? cause.message : String(cause)}`,
                        }),
                    })
                    : null
                await ambientStorage.run(localScope, () => hooks.callHook("boot"))
                loaded = true
                pulse?.start()
            } catch (error) {
                // A failed exec is not a half-loaded brain. Permit a clean
                // retry after the caller has recorded/recovered the failure.
                registered = null
                boundKernel = null
                pulse = null
                loaded = false
                throw error
            }
        },

        async wake(wake) {
            if (!loaded) throw err("COGNET_NO_LOOP", { detail: `${config.name} woken before load()`, context: { name: config.name } })
            const body = registered

            // Built BEFORE entering the scope, because the scope carries it.
            // Two overlapping wakes get two clocks and two stores, so each
            // body's phase() resolves its own no matter how the awaits
            // interleave. `emit` is bound through kernelOrThrow(), which
            // reads module state that outlives every wake — safe to close
            // over here.
            const clock = Clock({
                emit: (type, data) => kernelOrThrow().emit(type, data),
                signal: wake.signal,
                ticks: ticks,
            })

            return ambientStorage.run(scopeFor(clock, wake.at ?? null), async () => {
                await hooks.callHook("wake", wake)

                let stopped = false
                // The wake's stimuli enter the schedule once, on its first
                // tick; readers that run later take them from the buffer.
                let delivered = false
                // Counted per WAKE. `clock.tick` is the cognet's lifetime
                // counter, and comparing the limit against it made every wake
                // throw once the mind had lived `maxTicks` ticks in total.
                let ticked = 0
                const ctx: LoopCtx = { ...wake, stop: () => { stopped = true } }
                const maxTicks = config.maxTicksPerWake ?? Infinity

                const step = async (withBody: boolean) => {
                    if (ticked >= maxTicks) {
                        throw err("COGNET_MAX_TICKS", {
                            detail: `${config.name} exceeded ${maxTicks} ticks in one wake`,
                            context: { name: config.name, maxTicks },
                        })
                    }
                    ticked++
                    if (systems.length === 0) {
                        // A loop mind: the host ticks it, once a turn of the loop.
                        // tick hook is on the hot path — plugins here must stay cheap
                        await clock.runTick(async () => {
                            await hooks.callHook("tick", { tick: clock.tick })
                            if (withBody && body) await body(ctx)
                            else stopped = true
                        })
                        return
                    }
                    // A mind of systems: its schedule opens the tick, or
                    // merges this wake into the one waiting. With no loop, a
                    // wake is exactly one tick — the systems are the whole
                    // program, and a continuous mind is woken once per tick
                    // by its own clock.
                    threads ??= systems.some(entry => entry.system.thread === "worker")
                        ? Threads({ ecs: worldOrCreate(), url: new URL(import.meta.url), threads: config.threads, emit: (type, data) => kernelOrThrow().emit(type, data) })
                        : null
                    schedule ??= Schedule({
                        ecs: worldOrCreate(),
                        systems: systems,
                        emit: (type, data) => kernelOrThrow().emit(type, data),
                        trace: {
                            // tick hook is on the hot path — plugins here must stay cheap
                            tick: (fn, opened) => clockOrThrow().runTick(async note => {
                                await hooks.callHook("tick", { tick: clockOrThrow().tick })
                                return fn(note)
                            }, opened),
                            system: (name, fn, ran) => clockOrThrow().runSystem(name, fn, ran),
                        },
                        hz: config.mode.kind === "continuous" ? config.mode.hz : undefined,
                        ...(threads ? { threads: threads } : {}),
                        uses: Object.keys(config.uses ?? {}),
                        services: (entry, calls) => {
                            const declared = entry.system.uses ?? []
                            const gate = Gate({ system: entry.name, uses: declared, calls: calls, services: kernelOrThrow().services })
                            return { services: Typed({ system: entry.name, declared: declared, uses: config.uses ?? {}, gate: gate }), end: () => gate.end() }
                        },
                    })
                    await schedule.run({
                        now: wake.at ?? Date.now(),
                        stimuli: delivered ? [] : wake.stimuli,
                        signal: wake.signal,
                        ...(wake.lands && !delivered ? { lands: wake.lands } : {}),
                    })
                    delivered = true
                    stopped = true
                }

                while (!stopped && !wake.signal.aborted) await step(true)

                // THE WAKE OUTLIVES ITS TICKS until the async work it started
                // settles. That work makes engine calls, and the kernel
                // resolves their run — and their cancellation — from this
                // wake; released early, they would belong to a run nothing
                // can interrupt. The TICK never waits: other wakes keep
                // ticking while this one holds open.
                //
                // A mind with no clock has no next tick to land results in,
                // so it ticks again itself until nothing is left in flight —
                // "returns when quiescent". A continuous mind's clock lands
                // them within one period.
                if (schedule) {
                    const current = schedule
                    if (config.mode.kind === "continuous") {
                        await current.settled(wake.signal)
                    } else {
                        while (current.busy(wake.signal) && !wake.signal.aborted) {
                            await current.settled(wake.signal)
                            await step(false)
                        }
                    }
                }
            })
        },

        async unload() {
            pulse?.stop()
            pulse = null
            await ambientStorage.run(localScope, () => hooks.callHook("shutdown"))
            hooks.removeAllHooks()
            registered = null
            schedule = null
            await threads?.close()
            threads = null
            boundKernel = null
            loaded = false
        },
    }
}

// Last, so everything above exists before the first job: a worker answers
// once the whole bundle — systems included — has evaluated.
if (onWorker) {
    if (!parentPort) throw err("COGNET_WORKER_FAILED", { detail: "loaded as a systems worker with no parent port" })
    Serve({
        port: parentPort,
        systems: () => {
            if (!hosted) throw err("COGNET_WORKER_FAILED", { detail: "this module was loaded as a systems worker, but it is not a cognet bundle — nothing called CognetHost()" })
            return hosted
        },
        world: worldOrCreate,
    }).listen()
}
