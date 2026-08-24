import { Cpu } from "../../src/cpu"
import { Disk } from "../../src/disk"
import { readGpus } from "../../src/gpu"
import { readMemory } from "../../src/memory"
import { discoverNet, linkState, readNet } from "../../src/net"
import { discoverThermal, readChip } from "../../src/thermal"

/**
 * The machine, reported unjudged.
 *
 * No thresholds and no alarms: what 87°C MEANS is a judgment, and judgments
 * belong to the mind. The body says 87 and the mind decides whether that is
 * worth acting on.
 *
 * TWO CLOCKS, deliberately. CPU load moves fast enough that a 1Hz sample
 * averages away the spike you were looking for; thermal mass, disk
 * throughput and a shelled GPU query do not. One rate for everything would
 * either oversample the slow group or undersample the fast one.
 */

type ComputeOptions = {
    hz?: number
    slowHz?: number
    channel?: string
}

const COMPUTE = Symbol.for("axon.compute.sensors")
type Compute = {
    /** The runtime receiving readings — swapped on reload, never re-created. */
    target: { stim: (type: "cognet:stimulus:vector", data: Record<string, unknown>) => Promise<unknown> } | null
    stop: () => void
}
const store = globalThis as typeof globalThis & { [COMPUTE]?: Compute }

export default defineAxonPlugin(axon => {
    const running = store[COMPUTE]
    if (running) {
        running.target = axon
        return
    }

    const options = axon.modules.options<ComputeOptions>("compute")
    const hz = options.hz ?? 2
    const slowHz = options.slowHz ?? 1
    const prefix = options.channel ?? "/compute"

    // Discovered ONCE: the set of chips, interfaces and cores is fixed for
    // the life of the machine, and re-walking sysfs at sample rate would
    // cost more than the readings are worth.
    const cpu = Cpu()
    const disk = Disk()
    const chips = discoverThermal()
    const interfaces = discoverNet()

    // Rates need two samples; priming here means the first tick already has
    // a delta rather than reporting nothing for a second.
    cpu.load()
    disk.read()
    for (const iface of interfaces) readNet(iface)

    const parts = [`${cpu.cores} cores`]
    if (chips.length) parts.push(`${chips.length} thermal chips`)
    if (interfaces.length) parts.push(`${interfaces.map(i => `${i.name}(${linkState(i.name)})`).join(", ")}`)
    console.log(`[compute] ${parts.join(", ")} @ ${hz}/${slowHz}Hz → ${prefix}`)

    const emit = (channel: string, data: Record<string, unknown>): Promise<unknown> | undefined =>
        compute.target?.stim("cognet:stimulus:vector", { channel: `${prefix}/${channel}`, ...data })

    // ── fast: the things that move between blinks ───────────────────────────
    let fastBusy = false
    const fast = setInterval(() => {
        if (fastBusy) return
        fastBusy = true

        void (async () => {
            const load = cpu.load()
            if (load) {
                await emit("cpu/load", {
                    values: load,
                    unit: "%",
                    labels: load.map((_, i) => `core${i}`),
                    profile: "cpu.load",
                })
            }

            const freq = cpu.freq()
            if (freq) {
                await emit("cpu/freq", {
                    values: freq,
                    unit: "MHz",
                    labels: freq.map((_, i) => `core${i}`),
                    profile: "cpu.frequency",
                })
            }
        })().catch((cause: unknown) => {
            console.error("[compute] cpu sampling stopped:", cause)
        }).finally(() => {
            fastBusy = false
        })
    }, 1000 / hz)

    // ── slow: thermal mass, throughput, and a shelled GPU query ─────────────
    let slowBusy = false
    const slow = setInterval(() => {
        if (slowBusy) return
        slowBusy = true

        void (async () => {
            const memory = readMemory()
            await emit("memory", {
                values: memory.ram,
                unit: "MiB",
                labels: ["used", "available", "total"],
                profile: "memory",
            })
            if (memory.swap) {
                await emit("swap", {
                    values: memory.swap,
                    unit: "MiB",
                    labels: ["used", "total"],
                    profile: "memory",
                })
            }
            // The agent's own body, as distinct from the machine it runs on.
            await emit("self", {
                values: memory.self,
                labels: ["rss", "threads"],
                units: ["MiB", ""],
                profile: "process.self",
            })

            for (const chip of chips) {
                await emit(`thermal/${chip.name}`, {
                    values: readChip(chip),
                    unit: "°C",
                    labels: chip.labels,
                    profile: "temperature",
                })
            }

            const disks = disk.read()
            for (const device of disks ?? []) {
                await emit(`disk/${device.name}`, {
                    values: [device.rx, device.tx],
                    unit: "B/s",
                    labels: ["read", "write"],
                    profile: "throughput",
                })
            }

            for (const iface of interfaces) {
                const rate = readNet(iface)
                // No second sample yet, or the counter wrapped — nothing was
                // measured, so nothing is reported.
                if (!rate) continue
                await emit(`net/${iface.name}`, {
                    values: [rate.rx, rate.tx],
                    unit: "B/s",
                    labels: ["rx", "tx"],
                    profile: "throughput",
                })
            }

            for (const gpu of await readGpus()) {
                // Five components, four different units, one instrument, one
                // instant — the case `units[]` exists for.
                await emit(`gpu/${gpu.index}`, {
                    values: gpu.values,
                    labels: gpu.labels,
                    units: gpu.units,
                    profile: "gpu",
                })
            }
        })().catch((cause: unknown) => {
            console.error("[compute] machine sampling stopped:", cause)
        }).finally(() => {
            slowBusy = false
        })
    }, 1000 / slowHz)

    const compute: Compute = {
        target: axon,
        stop: () => {
            clearInterval(fast)
            clearInterval(slow)
        },
    }
    store[COMPUTE] = compute

    axon.hooks.hook("shutdown:before", () => {
        // A reload fires this too and must NOT stop the clocks — they
        // outlive any one runtime. Detach only.
        if (compute.target === axon) compute.target = null
    })
})
