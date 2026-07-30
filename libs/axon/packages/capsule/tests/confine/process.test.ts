import { Capsule } from "@axon/capsule"
import { probe } from "../../platform/confine/probe"

const boxed = probe().auto ? it : it.skip

async function confined() {
    const capsule = Capsule({ policy: { isolation: "auto", process: { spawn: false, run: true } } })
    await capsule.boot()
    return capsule
}

describe("Confinement — process isolation", () => {
    boxed("cannot see host processes (own pid namespace)", async () => {
        const capsule = await confined()
        const pids = await capsule.run(`
            const { readdirSync } = await import("node:fs")
            readdirSync("/proc").filter(n => /^\\d+$/.test(n)).length
        `)
        // In a fresh pid namespace only the box's own tree is visible — a
        // handful of pids, not the host's hundreds.
        expect(pids).toBeLessThan(20)
        await capsule.shutdown()
    })

    boxed("cannot signal the host init process", async () => {
        const capsule = await confined()
        // Host pid 1 is not the box's pid 1 (own pid namespace). Probe a high host
        // pid that cannot belong to the box's tiny tree — signalling it must fail.
        const out = await capsule.run(`
            let r = "blocked"
            try { process.kill(${process.pid}, 0); r = "REACHED" } catch { r = "blocked" }
            r
        `)
        expect(out).toBe("blocked")
        await capsule.shutdown()
    })
})
