import { err } from "@arcforge/err"
import type { AdaptersT, LoadedWeight } from "../adapter"
import type { ModelRecord } from "../types"
import type { InventoryT } from "../inventory"
import type { MachineT } from "../../machine"
import type { ActivityT } from "../activity"
import { Execution } from "../execution"
import { record } from "../record"

type LoadInput = { path: string; model: string; agent: string; role: string }

/**
 * How long a weight the daemon loaded ON ITS OWN stays resident unused.
 *
 * Long enough that an agent restarting — a brain reload, a crash and
 * relaunch — finds its models warm; short enough that a stopped agent does
 * not hold the GPU until the daemon exits. A weight a person loaded is
 * theirs to unload and never expires.
 */
export const KEEP_WARM_MS = 5 * 60_000
/** How often idle weights are looked for. */
const EXPIRY_CHECK_MS = 30_000

/** Own model residency, admission and inference leases. */
export function Residence(opts: { inventory: InventoryT; adapters: AdaptersT; machine: MachineT; activity: ActivityT; autoload?: () => boolean; keepWarmMs?: number; now?: () => number }) {
    const resident = new Map<string, { weight: LoadedWeight; record: ModelRecord; hold: string }>()
    /** Weights loaded to serve inference, not by a person — the ones that expire — and when each was last used. */
    const autoloaded = new Map<string, number>()
    const now = opts.now ?? Date.now
    const keepWarm = opts.keepWarmMs ?? KEEP_WARM_MS
    const retiring = new Map<string, Promise<boolean>>()
    const loading = new Map<string, Promise<ModelRecord>>()
    async function load(input: LoadInput): Promise<ModelRecord> {
        if (retiring.has(input.model)) throw err("MODEL_IN_USE", { detail: `${input.model} is unloading` })
        const existing = resident.get(input.model)
        if (existing) return existing.record
        const pending = loading.get(input.model)
        if (pending) return pending
        const work = opts.activity.run("load", input.model, async () => {
            const estimate = opts.inventory.current.find(model => model.id === input.model)?.bytes
            if (estimate !== undefined && estimate !== null) {
                const verdict = opts.machine.admit(estimate)
                if (!verdict.ok) throw err("MODEL_WILL_NOT_FIT", { detail: `${input.model} needs at least ${estimate} bytes; ${verdict.available} are available` })
            }
            const { runtime, weight } = await opts.adapters.load(input.path)
            try {
                const verdict = opts.machine.admit(weight.bytes)
                if (!verdict.ok) throw err("MODEL_WILL_NOT_FIT", {
                    detail: `${input.model} needs ${weight.bytes} bytes; ${verdict.available} are available`,
                    context: { holders: verdict.holders.map(hold => `${hold.agent}:${hold.model}`) },
                })
                const hold = opts.machine.residency.take({ agent: input.agent, role: input.role, model: input.model, bytes: weight.bytes })
                const known = opts.inventory.current.find(model => model.id === input.model)
                const base = known ? { ...known, resident: true } : record({ model: input.model, bytes: weight.bytes, path: input.path, runtime: runtime, cached: true, resident: true })
                const loaded = {
                    ...base,
                    ...(weight.device ? { device: weight.device } : {}),
                    ...(weight.deviceNote ? { deviceNote: weight.deviceNote } : {}),
                }
                resident.set(input.model, { weight: weight, record: loaded, hold: hold.id })
                return loaded
            } catch (cause) { await weight.unload(); throw cause }
        }).finally(() => loading.delete(input.model))
        loading.set(input.model, work)
        return work
    }
    async function pin(model: string): Promise<ModelRecord> {
        const records = await opts.inventory.refresh()
        const entry = records.find(entry => entry.id === model)
        if (!entry || !entry.path) throw err("MODEL_NOT_CACHED", { detail: `${model} is not on this machine — download it before use` })
        return load({ path: entry.path, model: model, agent: "you", role: "manual" })
    }
    async function acquire(model: string): Promise<LoadedWeight> {
        if (retiring.has(model)) throw err("MODEL_IN_USE", { detail: `${model} is unloading` })
        let entry = resident.get(model)
        if (!entry) {
            if (!(opts.autoload?.() ?? true)) throw err("MODEL_NOT_RESIDENT", { detail: `${model} is not loaded — load it before inference` })
            await pin(model)
            autoloaded.set(model, now())
            entry = resident.get(model)
        }
        if (!entry) throw err("MODEL_LOAD_FAILED", { detail: `${model} loaded without recording a resident weight` })
        return entry.weight
    }
    const execution = Execution({ acquire: acquire })

    /** Unload every autoloaded weight unused for longer than `keepWarm`. What a stopped agent leaves behind. */
    async function expire(): Promise<string[]> {
        const expired: string[] = []
        for (const [model, used] of autoloaded) {
            if (execution.busy(model) || now() - used < keepWarm || !resident.has(model)) continue
            autoloaded.delete(model)
            await unload(model)
            expired.push(model)
        }
        return expired
    }
    const expiry = setInterval(() => { void expire() }, EXPIRY_CHECK_MS)
    // The daemon's lifetime is not this timer's to hold.
    expiry.unref?.()

    /** Mark a weight used, now and when the call ends — a long call is not idle while it runs. */
    function touch<T>(model: string, work: Promise<T>): Promise<T> {
        if (autoloaded.has(model)) autoloaded.set(model, now())
        return work.finally(() => { if (autoloaded.has(model)) autoloaded.set(model, now()) })
    }
    async function unload(model: string): Promise<boolean> {
        const pending = retiring.get(model)
        if (pending) return pending
        execution.assertIdle(model)
        if (loading.has(model)) throw err("MODEL_IN_USE", { detail: `${model} is still loading` })
        const entry = resident.get(model)
        if (!entry) return false
        autoloaded.delete(model)
        const work = opts.activity.run("unload", model, async () => {
            await entry.weight.unload()
            resident.delete(model)
            opts.machine.residency.release(entry.hold)
            return true
        }).finally(() => retiring.delete(model))
        retiring.set(model, work)
        return work
    }
    async function remove(model: string, work: () => Promise<boolean>): Promise<boolean> {
        if (retiring.has(model)) throw err("MODEL_IN_USE", { detail: `${model} is unloading or being removed` })
        execution.assertIdle(model)
        if (loading.has(model)) throw err("MODEL_IN_USE", { detail: `${model} is still loading` })
        const task = (async () => {
            const entry = resident.get(model)
            if (entry) {
                await entry.weight.unload()
                resident.delete(model)
                opts.machine.residency.release(entry.hold)
            }
            return work()
        })().finally(() => retiring.delete(model))
        retiring.set(model, task)
        return task
    }
    async function dispose(): Promise<void> {
        clearInterval(expiry)
        await Promise.all([...resident.keys()].map(unload))
    }
    return {
        get current() { return [...resident.values()].map(entry => entry.record) },
        has: (model: string) => resident.has(model), load: load,
        /** A person loading a weight makes it theirs: it no longer expires. */
        pin: (model: string) => { autoloaded.delete(model); return pin(model) },
        unload: unload, remove: remove, dispose: dispose, expire: expire,
        run: (input: Parameters<typeof execution.run>[0]) => touch(input.model, opts.activity.run("inference", input.model, () => execution.run(input))),
        stream: async function* (input: Parameters<typeof execution.stream>[0], signal?: AbortSignal) {
            const mark = () => { if (autoloaded.has(input.model)) autoloaded.set(input.model, now()) }
            mark()
            try { yield* opts.activity.stream(input.model, () => execution.stream(input, signal)) } finally { mark() }
        },
    }
}
export type ResidenceT = ReturnType<typeof Residence>
