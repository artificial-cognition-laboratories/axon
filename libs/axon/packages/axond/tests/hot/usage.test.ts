import { describe, expect, test } from "bun:test"
import { Usage } from "../../src/agents"
import { Attribution } from "../../src/machine"
import type { LabState } from "../../src/labs"

/** A machine that reports fixed totals, and counts who is watching it. */
function machine() {
    let observers = 0
    return {
        observers: () => observers,
        machine: {
            attribution: Attribution({ command: ["/nonexistent/nvidia-smi"] }),
            observe: () => { observers++; return () => { observers-- } },
            state: () => ({
                capacity: { cores: 8, ram: 16e9, vram: 11e9 },
                usage: { cpuUtil: 25, ramAvailable: 10e9, gpuUtil: 40, vramUsed: 2e9 },
            }),
        } as never,
    }
}

/** A lab's state with one body, leased — or not — by `pid`. */
function lab(leasedBy: number | null): LabState {
    return {
        leases: leasedBy === null ? [] : [{ id: "l1", body: "b1", world: "flat", agent: "terry", pid: leasedBy, identity: "terry", stateDir: "/tmp", at: "" }],
        bodies: [{ id: "b1", pids: [process.pid] }, { id: "b2", pids: [999_999] }],
        // Two worlds beside each other: only the one the lease is in is this agent's cost.
        running: [{ name: "flat", pid: process.pid }, { name: "kitchen", pid: 999_998 }],
    } as never
}

describe("usage — what one agent costs", () => {
    test("reports its brain and its host always, and a body and world once a pid in its tree leases one", async () => {
        const { machine: box } = machine()
        let leased: number | null = null
        const usage = Usage({ machine: box, labs: async () => [lab(leased)], host: { pid: process.pid, name: "terminal" } })
        const sampler = usage.of(process.pid)

        const alone = await sampler.measure()
        expect(Object.keys(alone.parts).sort()).toEqual(["brain", "terminal"])
        expect(alone.parts.terminal!.shared).toBe(true)
        expect(alone.parts.brain!.shared).toBe(false)
        // The host is counted alone — its children are other parts.
        expect(alone.parts.terminal!.processes).toBe(1)
        expect(alone.machine).toMatchObject({ cores: 8, cpu: 25, ram: { used: 6e9, total: 16e9 }, gpu: 40, vram: { used: 2e9, total: 11e9 } })
        expect(alone.threads.some(thread => thread.tid === process.pid)).toBe(true)

        // A lease by someone outside the tree is not this agent's body.
        leased = 1
        expect(Object.keys((await sampler.measure()).parts).sort()).toEqual(["brain", "terminal"])

        leased = process.pid
        const embodied = await sampler.measure()
        expect(Object.keys(embodied.parts).sort()).toEqual(["body", "brain", "terminal", "world"])
        // Only the leased body's processes.
        expect(embodied.parts.body!.processes).toBe(1)
        expect(embodied.parts.world!.shared).toBe(true)
        sampler.close()
    })

    test("keeps the machine sampling fast while an agent is watched, and lets it go on close", () => {
        const { machine: box, observers } = machine()
        const sampler = Usage({ machine: box, labs: async () => [], host: { pid: process.pid, name: "daemon" } }).of(process.pid)
        expect(observers()).toBe(1)
        sampler.close()
        expect(observers()).toBe(0)
    })
})
