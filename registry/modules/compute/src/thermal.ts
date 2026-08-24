import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * capture/thermal — the machine's own temperature sensors, as readings.
 *
 * Linux exposes every thermal sensor through hwmon: one directory per chip
 * under /sys/class/hwmon, each with a `name` and some number of
 * `tempN_input` files in millidegrees, optionally with `tempN_label`.
 *
 * ONE CHIP IS ONE CHANNEL, not one sensor. A CPU package reports nine
 * temperatures — the package and each core — and they are read at one
 * instant from one device. Emitting nine separate readings would throw away
 * the fact that they are simultaneous, and no consumer could ever recover
 * it. That is the whole reason a measurement is a vector: atomicity belongs
 * to the instrument.
 *
 * Knows nothing about Axon, like every other capture module here: it reads
 * sysfs and returns numbers. What they mean is the mind's business.
 */

const HWMON = "/sys/class/hwmon"

export type ThermalChip = {
    /** The chip's own name — "coretemp", "nvme", "iwlwifi_1". */
    name: string
    /** What each value is, in the order they are read. */
    labels: string[]
    /** Absolute paths of the inputs, cached so a read is not a directory walk. */
    inputs: string[]
}

/** Sensor number from `tempN_input`, so inputs sort 1,2,…,10 rather than 1,10,2. */
function inputIndex(file: string): number {
    const match = /^temp(\d+)_input$/.exec(file)
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * Every hwmon chip that reports at least one temperature.
 *
 * Enumerated ONCE at construction rather than per read: the set of chips is
 * fixed for the life of the machine, and re-walking sysfs at sample rate
 * would make reading a temperature cost more than the temperature is worth.
 */
export function discoverThermal(): ThermalChip[] {
    if (!existsSync(HWMON)) return []

    const chips: ThermalChip[] = []

    for (const dir of readdirSync(HWMON)) {
        const base = join(HWMON, dir)

        const files = readdirSync(base)
            .filter(file => /^temp\d+_input$/.test(file))
            .sort((a, b) => inputIndex(a) - inputIndex(b))

        if (files.length === 0) continue

        const name = read(join(base, "name")) ?? dir
        const labels = files.map(file => {
            const label = read(join(base, file.replace("_input", "_label")))
            // No label is normal for single-sensor chips (nvme, wifi). Fall
            // back to the sensor's own number so a component is never
            // anonymous — "temp1" is a worse name than "Core 0" and a much
            // better one than nothing.
            return label ?? file.replace("_input", "")
        })

        chips.push({ name, labels, inputs: files.map(file => join(base, file)) })
    }

    return chips
}

function read(path: string): string | null {
    try {
        return readFileSync(path, "utf-8").trim()
    } catch {
        // A sensor can disappear (a device unbinding, a driver unloading).
        // Absent is a real state, not an error worth throwing over.
        return null
    }
}

/**
 * Read one chip, now. Returns °C per input, in `labels` order.
 *
 * A sensor that fails mid-read yields NaN rather than shifting every later
 * value left — the array must stay index-aligned with `labels`, or the
 * reading silently mislabels itself.
 */
export function readChip(chip: ThermalChip): number[] {
    return chip.inputs.map(path => {
        const raw = read(path)
        if (raw === null) return Number.NaN
        // hwmon reports millidegrees. One decimal is the honest resolution:
        // these sensors are ±1°C at best, and more digits would imply a
        // precision the hardware does not have.
        return Math.round(Number(raw) / 100) / 10
    })
}
