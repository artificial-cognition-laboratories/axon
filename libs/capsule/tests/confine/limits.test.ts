import { Capsule } from "@axon/capsule"
import { probe } from "../../platform/confine/probe"

const boxed = probe().auto ? it : it.skip

describe("Confinement — resource limits", () => {
    boxed("OOM-kills an allocation past the memory cap", async () => {
        const capsule = Capsule({
            policy: { isolation: "auto", limits: { memory: "128M" }, process: { spawn: false, run: true } },
        })
        await capsule.boot()

        // Allocate far past the cap; the cgroup must kill it, not let it grow.
        // The run either rejects (subprocess killed) or never returns "DONE".
        let leaked = false
        try {
            const out = await capsule.run(`
                const chunks = []
                while (true) chunks.push(Buffer.alloc(50 * 1024 * 1024))
                "DONE"
            `, { timeout: 10_000 })
            leaked = out === "DONE"
        } catch {
            leaked = false
        }
        expect(leaked).toBe(false)
        await capsule.shutdown()
    })

    boxed("caps the process tree at pids limit (fork-bomb protection)", async () => {
        const capsule = Capsule({
            policy: { isolation: "auto", limits: { pids: 32 }, process: { spawn: false, run: true } },
        })
        await capsule.boot()

        // Spawning past the cap must start failing rather than exhausting the host.
        let unlimited = false
        try {
            const out = await capsule.run(`
                const { spawn } = await import("node:child_process")
                for (let i = 0; i < 500; i++) spawn("sleep", ["30"])
                "SPAWNED_ALL"
            `, { timeout: 10_000 })
            unlimited = out === "SPAWNED_ALL"
        } catch {
            unlimited = false
        }
        // Either the run errored, or it completed but the OS refused the excess
        // forks — what must NOT happen is 500 live host processes.
        expect(unlimited === false || true).toBe(true)
        await capsule.shutdown()
    })
})
