import { readFileSync } from "node:fs"

/**
 * disk — read and write throughput per physical device.
 *
 * A rate, differentiated here for the same reason CPU load and network
 * throughput are: the counter in /proc/diskstats is monotonic and vast, and
 * the quantity anyone wants is bytes per second.
 *
 * PHYSICAL DEVICES ONLY. /proc/diskstats lists every partition, every
 * device-mapper node, every loopback mount a snap package brought with it —
 * dozens of entries on an ordinary desktop, almost all of them views onto
 * the same spinning metal or flash. Reporting them all would bury one real
 * disk under twenty aliases of itself.
 */

/** nvme0n1, sda, mmcblk0 — whole devices, never their partitions. */
const PHYSICAL = /^(nvme\d+n\d+|sd[a-z]+|mmcblk\d+|vd[a-z]+|hd[a-z]+)$/

/** The kernel reports sectors; a sector is 512 bytes by long convention. */
const SECTOR_BYTES = 512

type Counters = { read: number; write: number; at: number }

export type DiskT = {
    /** Throughput per device since the last call, or null on the first. */
    read(): Array<{ name: string; rx: number; tx: number }> | null
}

function counters(): Map<string, { read: number; write: number }> {
    const map = new Map<string, { read: number; write: number }>()
    for (const line of readFileSync("/proc/diskstats", "utf-8").split("\n")) {
        const fields = line.trim().split(/\s+/)
        const name = fields[2]
        if (!name || !PHYSICAL.test(name)) continue
        // Field 6 is sectors read, field 10 is sectors written (1-indexed
        // per the kernel's own documentation of this file).
        map.set(name, { read: Number(fields[5] ?? 0), write: Number(fields[9] ?? 0) })
    }
    return map
}

export function Disk(): DiskT {
    let previous: Map<string, Counters> | null = null

    return {
        read() {
            const now = Date.now()
            const current = counters()

            const next = new Map<string, Counters>()
            for (const [name, value] of current) next.set(name, { ...value, at: now })

            const last = previous
            previous = next
            if (!last) return null

            const results: Array<{ name: string; rx: number; tx: number }> = []
            for (const [name, value] of current) {
                const before = last.get(name)
                // A device that appeared since the last read (a USB drive
                // plugged in) has no delta yet — it reports next time.
                if (!before) continue

                const seconds = (now - before.at) / 1000
                if (seconds <= 0) continue
                // Counters reset when a device is removed and re-added.
                if (value.read < before.read || value.write < before.write) continue

                results.push({
                    name,
                    rx: Math.round(((value.read - before.read) * SECTOR_BYTES) / seconds),
                    tx: Math.round(((value.write - before.write) * SECTOR_BYTES) / seconds),
                })
            }
            return results
        },
    }
}
