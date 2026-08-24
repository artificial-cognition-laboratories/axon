import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * capture/net — network interfaces, as throughput.
 *
 * THE RATE QUESTION. The kernel exposes monotonic counters
 * (`rx_bytes` since boot), and what a mind wants is bytes per second. So
 * who differentiates: the body, or the brain?
 *
 * "Zero cognition before the cognet" argues for shipping the counter. But
 * differentiation is not cognition — it is what the INSTRUMENT reports. A
 * speedometer does not hand you an odometer reading and ask you to
 * subtract; a wheel encoder's driver reports velocity. Interpreting a rate
 * (is 40MB/s a lot? is this an attack?) is the judgment, and that stays with
 * the mind, untouched.
 *
 * There is also a practical argument the principle does not override: a
 * counter is monotonic and enormous (186,019,779 and climbing), so a lane
 * plotting it draws a straight line forever and every real change is lost
 * in the scale. A rate is the quantity that actually varies.
 *
 * So the body differentiates, and says so by reporting a unit of B/s. The
 * counter is not hidden — it is simply not what this instrument measures.
 */

const NET = "/sys/class/net"

export type NetInterface = {
    name: string
    /** Last counter read, for differentiation. */
    last: { rx: number; tx: number; at: number } | null
}

/**
 * Real interfaces only.
 *
 * A machine running containers has dozens of virtual devices (docker0,
 * br-*, veth*) that are plumbing rather than senses — an agent has no more
 * business feeling a veth pair than a person has feeling their own
 * capillaries. Loopback is excluded for the same reason: traffic a machine
 * sends to itself is not the world reaching it.
 */
function isReal(name: string): boolean {
    if (name === "lo") return false
    if (/^(docker|br-|veth|virbr|tun|tap)/.test(name)) return false
    return true
}

export function discoverNet(): NetInterface[] {
    if (!existsSync(NET)) return []
    return readdirSync(NET)
        .filter(isReal)
        .sort()
        .map(name => ({ name, last: null }))
}

function counter(name: string, which: "rx_bytes" | "tx_bytes"): number {
    try {
        return Number(readFileSync(join(NET, name, "statistics", which), "utf-8").trim())
    } catch {
        return Number.NaN
    }
}

/** "up" | "down" | "unknown" — a cable state, not a judgment about it. */
export function linkState(name: string): string {
    try {
        return readFileSync(join(NET, name, "operstate"), "utf-8").trim()
    } catch {
        return "unknown"
    }
}

/**
 * Throughput since the last read, in bytes/second.
 *
 * Returns null on the FIRST read of an interface: a rate needs two samples,
 * and there is no honest value to report from one. Emitting zero would be a
 * measurement nobody took.
 */
export function readNet(iface: NetInterface): { rx: number; tx: number } | null {
    const rx = counter(iface.name, "rx_bytes")
    const tx = counter(iface.name, "tx_bytes")
    const at = Date.now()

    const previous = iface.last
    iface.last = { rx, tx, at }

    if (!previous) return null

    const seconds = (at - previous.at) / 1000
    if (seconds <= 0) return null

    // A counter that went BACKWARDS wrapped or was reset (an interface
    // reinitialising). The delta is meaningless, so this sample is skipped
    // rather than reported as a vast negative rate.
    if (rx < previous.rx || tx < previous.tx) return null

    return {
        rx: Math.round((rx - previous.rx) / seconds),
        tx: Math.round((tx - previous.tx) / seconds),
    }
}
