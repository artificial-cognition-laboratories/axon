import { Hookable } from "hookable"
import { AsyncLocalStorage } from "node:async_hooks"
import { err } from "@arcforge/err"
import type { AxonRunResult, CognetConfig, CognetDefinition, CognetHooks, CognetPlugin, CognetWake, KernelAbi } from "@arcforge/types"
import type { AxonOutputEvent } from "@arcforge/types"
import { Clock } from "./clock"

/**
 * CognetHost — the runtime half of the cognet authoring surface.
 *
 * A cognet is authored as two clutter-free files:
 *   cognet.config.ts — identity: `export default defineCognet({ name, ... })`
 *   src/main.ts      — a RAW SCRIPT: `loop(async ({ stop, ... }) => { ... })`
 *                      with typed ambient globals (kernel, loop, phase,
 *                      system) and normal imports.
 *
 * The CLI compile step wraps main.ts in a callable (imports hoisted out,
 * body deferred) and generates an entry that composes this host with the
 * config — so authors never see defineCognet-with-lifecycle boilerplate,
 * and the desugared form is an ordinary CognetDefinition against the ABI:
 * there is no side channel around it.
 *
 * IMPORTING THIS MODULE INSTALLS THE GLOBALS (that's why it is not exported
 * from the cognet index — only generated bundle entries import it, first,
 * so config/main evaluate with the globals present). One brain per process;
 * each bundle carries its own inlined copy of this module's state.
 *
 * Global rules (the contract from the sketch):
 * - process-lifetime things are ambient (kernel, loop)
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
    if (!scope) throw err("COGNET_ACCESSED_BEFORE_LOAD", { detail: "cognet globals are only available inside this brain's load, wake, and shutdown scope" })
    return scope
}

// The cognet's own lifecycle hooks — a SEPARATE hookable from Axon's, one
// ring down. The kernel drives the brain's life through the host; the host
// fires these at the four fixed points. Awaited-to-completion, in order.
const hooks = new Hookable<CognetHooks>()

function kernelOrThrow(): KernelAbi {
    if (!boundKernel) throw err("COGNET_ACCESSED_BEFORE_LOAD", { detail: "kernel is not available yet — it binds at load(); do work inside loop(), not at module top level" })
    return boundKernel
}

function clockOrThrow(): ReturnType<typeof Clock> {
    const clock = ambientStorage.getStore()?.clock
    if (!clock) throw err("COGNET_ACCESSED_BEFORE_LOAD", { detail: "phase()/system() are wake-scoped — call them inside the loop body" })
    return clock
}

// ── ambient globals ──────────────────────────────────────────────────────────

const globals = globalThis as Record<string, unknown>

globals.defineCognet = <T extends CognetConfig>(config: T): T => config

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

// the syscall table, delegating — live from load() onward
const localKernel = {
    output: (type: keyof AxonOutputEvent, data: never) => kernelOrThrow().output(type, data),
    engine: engineFacade(() => kernelOrThrow()),
    run,
    scope: () => kernelOrThrow().scope(),
    base: () => kernelOrThrow().base(),
    emit: (type: never, data: never) => kernelOrThrow().emit(type, data),
    fault: (input: Parameters<KernelAbi["fault"]>[0]) => kernelOrThrow().fault(input),
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
function scopeFor(clock: ReturnType<typeof Clock> | null): CognetAmbientScope {
    return {
        kernel: localKernel,
        loop: registerLoop,
        phase: <T>(name: string, fn: () => Promise<T>) => clockOrThrow().runPhase(name, fn),
        system: <T>(name: string, fn: () => Promise<T>) => clockOrThrow().runSystem(name, fn),
        clock,
    }
}

/** Load, boot and shutdown run outside any wake, so they carry no clock. */
const localScope: CognetAmbientScope = scopeFor(null)

// Stable process-wide facades. They never capture one cognet instance; every
// operation resolves the current async scope at the moment it is performed.
globals.loop = (body: LoopBody): void => ambientOrThrow().loop(body)
globals.kernel = {
    output: (type: keyof AxonOutputEvent, data: never) => ambientOrThrow().kernel.output(type, data),
    engine: engineFacade(() => ambientOrThrow().kernel),
    run: ((code: string | string[]) => ambientOrThrow().kernel.run(code as never)) as KernelAbi["run"],
    scope: () => ambientOrThrow().kernel.scope(),
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
    // Resolved through kernelOrThrow(), not ambientOrThrow(): a plugin's
    // clock lives in a setInterval registered during boot, and that callback
    // fires outside every ambient scope. The bound kernel is module state
    // that outlives each wake, which is exactly what a driver needs.
    wake: () => kernelOrThrow().wake(),
    clock: () => kernelOrThrow().clock(),
} satisfies KernelAbi

globals.phase = <T>(name: string, fn: () => Promise<T>) => ambientOrThrow().phase(name, fn)
globals.system = <T>(name: string, fn: () => Promise<T>) => ambientOrThrow().system(name, fn)

// ── composition (what the generated entry calls) ────────────────────────────

/**
 * config + wrapped main → the definition the kernel loads. main() runs once
 * at load(), with kernel already bound — its module/closure scope is the
 * brain's resident RAM. It must declare exactly one loop().
 */
export function CognetHost(config: CognetConfig, main: () => Promise<void>): CognetDefinition {
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
                await ambientStorage.run(localScope, main) // declares loop(); plugins already registered at import time
                if (!registered) {
                    throw err("COGNET_NO_LOOP", { detail: `${config.name} ran main() without declaring loop()`, context: { name: config.name } })
                }
                await ambientStorage.run(localScope, () => hooks.callHook("boot"))
                loaded = true
            } catch (error) {
                // A failed exec is not a half-loaded brain. Permit a clean
                // retry after the caller has recorded/recovered the failure.
                registered = null
                boundKernel = null
                throw error
            }
        },

        async wake(wake) {
            const body = registered
            if (!body) throw err("COGNET_NO_LOOP", { detail: `${config.name} woken before load()`, context: { name: config.name } })

            // Built BEFORE entering the scope, because the scope carries it.
            // Two overlapping wakes get two clocks and two stores, so each
            // body's phase() resolves its own no matter how the awaits
            // interleave. `emit` is bound through kernelOrThrow(), which
            // reads module state that outlives every wake — safe to close
            // over here.
            const clock = Clock({ emit: (type, data) => kernelOrThrow().emit(type, data), signal: wake.signal })

            return ambientStorage.run(scopeFor(clock), async () => {
                await hooks.callHook("wake", wake)

                let stopped = false
                const ctx: LoopCtx = { ...wake, stop: () => { stopped = true } }
                const maxTicks = config.maxTicksPerWake ?? Infinity
                while (!stopped && !wake.signal.aborted) {
                    if (clock.tick >= maxTicks) {
                        throw err("COGNET_MAX_TICKS", {
                            detail: `${config.name} exceeded ${maxTicks} ticks in one wake`,
                            context: { name: config.name, maxTicks },
                        })
                    }
                    // tick hook is on the hot path — plugins here must stay cheap
                    await clock.runTick(async () => {
                        await hooks.callHook("tick", { tick: clock.tick })
                        await body(ctx)
                    })
                }
            })
        },

        async unload() {
            await ambientStorage.run(localScope, () => hooks.callHook("shutdown"))
            hooks.removeAllHooks()
            registered = null
            boundKernel = null
            loaded = false
        },
    }
}
