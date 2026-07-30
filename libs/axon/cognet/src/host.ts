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
let currentClock: ReturnType<typeof Clock> | null = null
let loaded = false

type CognetAmbientScope = {
    kernel: KernelAbi
    loop(body: LoopBody): void
    phase<T>(name: string, fn: () => Promise<T>): Promise<T>
    system<T>(name: string, fn: () => Promise<T>): Promise<T>
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
    if (!currentClock) throw err("COGNET_ACCESSED_BEFORE_LOAD", { detail: "phase()/system() are wake-scoped — call them inside the loop body" })
    return currentClock
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
function run(code: string, opts?: { signal?: AbortSignal }): Promise<AxonRunResult>
function run(code: string[], opts?: { signal?: AbortSignal }): Promise<AxonRunResult[]>
function run(code: string | string[], opts?: { signal?: AbortSignal }) {
    if (Array.isArray(code)) return kernelOrThrow().run(code, opts)
    return kernelOrThrow().run(code, opts)
}

// the syscall table, delegating — live from load() onward
const localKernel = {
    output: (type: keyof AxonOutputEvent, data: never) => kernelOrThrow().output(type, data),
    stream: (req: never) => kernelOrThrow().stream(req),
    run,
    scope: () => kernelOrThrow().scope(),
    base: () => kernelOrThrow().base(),
    emit: (type: never, data: never) => kernelOrThrow().emit(type, data),
    // store is a live sub-object on the bound ABI — delegate per call, same
    // discipline as every other syscall (never captured before load())
    store: {
        session: {
            get: (opts?: { after?: number }) => kernelOrThrow().store.session.get(opts),
        },
        get: (key: never) => kernelOrThrow().store.get(key),
        set: (key: never, value: never) => kernelOrThrow().store.set(key, value),
    },
} satisfies KernelAbi

const localScope: CognetAmbientScope = {
    kernel: localKernel,
    loop: registerLoop,
    phase: <T>(name: string, fn: () => Promise<T>) => clockOrThrow().runPhase(name, fn),
    system: <T>(name: string, fn: () => Promise<T>) => clockOrThrow().runSystem(name, fn),
}

// Stable process-wide facades. They never capture one cognet instance; every
// operation resolves the current async scope at the moment it is performed.
globals.loop = (body: LoopBody): void => ambientOrThrow().loop(body)
globals.kernel = {
    output: (type: keyof AxonOutputEvent, data: never) => ambientOrThrow().kernel.output(type, data),
    stream: (req: never) => ambientOrThrow().kernel.stream(req),
    run: ((code: string | string[], opts?: { signal?: AbortSignal }) => ambientOrThrow().kernel.run(code as never, opts)) as KernelAbi["run"],
    scope: () => ambientOrThrow().kernel.scope(),
    base: () => ambientOrThrow().kernel.base(),
    emit: (type: never, data: never) => ambientOrThrow().kernel.emit(type, data),
    store: {
        session: { get: (opts?: { after?: number }) => ambientOrThrow().kernel.store.session.get(opts) },
        get: (key: never) => ambientOrThrow().kernel.store.get(key),
        set: (key: never, value: never) => ambientOrThrow().kernel.store.set(key, value),
    },
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
            return ambientStorage.run(localScope, async () => {
            const body = registered
            if (!body) throw err("COGNET_NO_LOOP", { detail: `${config.name} woken before load()`, context: { name: config.name } })

            const clock = Clock({ emit: (type, data) => kernelOrThrow().emit(type, data), signal: wake.signal })
            currentClock = clock

            await hooks.callHook("wake", wake)

            try {
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
            } finally {
                currentClock = null
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
