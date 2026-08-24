/**
 * gpu — temperature, utilisation, memory and power, per device.
 *
 * THE FIRST GENUINELY MIXED-UNIT READING. One GPU reports °C, %, MiB and W
 * from one device at one instant — which is what `units[]` on the vector
 * kind exists for, and why splitting these into four channels would be
 * wrong: they are one sample of one instrument, and comparing a temperature
 * against a utilisation from a different moment is how a phantom
 * correlation appears.
 *
 * VENDOR-SPECIFIC, AND HONEST ABOUT IT. There is no /proc/gpuinfo: NVIDIA
 * answers through nvidia-smi, AMD through sysfs under /sys/class/drm, and
 * Intel through something else again. Only the NVIDIA reader is implemented
 * here, because it is the one that can be tested on this machine — writing
 * the others blind is how untested code rots in. A machine with no NVIDIA
 * GPU reports no GPU lanes, which is the same "a body has whatever it has"
 * rule every other sensor follows.
 *
 * The shape is what makes adding a vendor cheap: a reader is a function
 * returning `GpuReading[]`, and `readGpus()` tries each in turn.
 */

export type GpuReading = {
    /** Device index, for the channel address. */
    index: number
    /** Human name — "NVIDIA GeForce RTX 2080 Ti". */
    name: string
    /** [temp, utilisation, memory used, memory total, power] */
    values: number[]
    labels: string[]
    units: string[]
}

const LABELS = ["temperature", "utilisation", "memory.used", "memory.total", "power"]
const UNITS = ["°C", "%", "MiB", "MiB", "W"]

/**
 * NVIDIA, via nvidia-smi.
 *
 * The CSV query interface is stable across driver versions and needs no
 * bindings — a shelled command every few seconds is far cheaper than a
 * native dependency in a module installed into every agent.
 */
async function readNvidia(): Promise<GpuReading[]> {
    if (!Bun.which("nvidia-smi")) return []

    const proc = Bun.spawn([
        "nvidia-smi",
        "--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw",
        "--format=csv,noheader,nounits",
    ], { stdout: "pipe", stderr: "ignore" })

    // A driver that hangs must not stall the sampling loop.
    const timeout = new Promise<string>(resolve => setTimeout(() => { proc.kill(); resolve("") }, 3000))
    const text = await Promise.race([new Response(proc.stdout).text(), timeout])

    const readings: GpuReading[] = []
    for (const line of text.trim().split("\n")) {
        if (!line.trim()) continue
        const parts = line.split(",").map(part => part.trim())
        if (parts.length < 7) continue

        // Any field can read "[N/A]" — a laptop GPU with no power sensor,
        // a card that does not report utilisation while idle. NaN keeps the
        // array index-aligned with its labels; dropping the field would
        // silently mislabel every value after it.
        const number = (value: string): number => {
            const parsed = Number(value)
            return Number.isFinite(parsed) ? parsed : Number.NaN
        }

        readings.push({
            index: Number(parts[0]),
            name: parts[1]!,
            values: parts.slice(2, 7).map(number),
            labels: LABELS,
            units: UNITS,
        })
    }
    return readings
}

/** Every GPU this machine can report on. Empty is an ordinary answer. */
export async function readGpus(): Promise<GpuReading[]> {
    // Vendors are tried in turn; the first that answers wins. A machine
    // with both an integrated and a discrete GPU reports whichever reader
    // knows about them — a real limitation, and a smaller one than
    // guessing at an API nobody here can exercise.
    return readNvidia()
}
