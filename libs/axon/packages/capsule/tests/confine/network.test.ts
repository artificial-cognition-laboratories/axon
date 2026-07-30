import { Capsule } from "@axon/capsule"
import { probe } from "../../platform/confine/probe"

const boxed = probe().auto ? it : it.skip

/**
 * Network is on/off at the OS layer for now (per-host nft allowlisting is the
 * privileged follow-up). These assert the floor: no `network` policy → the box
 * has no network stack at all; a `network` grant → the box can reach out. The
 * mediator remains the per-host distinction until the allowlist lands.
 */
describe("Confinement — network", () => {
    boxed("has no network when no destination is declared", async () => {
        const capsule = Capsule({ policy: { isolation: "auto", process: { spawn: false, run: true } } })
        await capsule.boot()
        const out = await capsule.run(`
            let r = "blocked"
            try {
                await fetch("https://example.com", { signal: AbortSignal.timeout(4000) })
                r = "REACHED"
            } catch { r = "blocked" }
            r
        `, { timeout: 8_000 })
        expect(out).toBe("blocked")
        await capsule.shutdown()
    })

    boxed("can reach the network when a destination is declared", async () => {
        const capsule = Capsule({
            policy: { isolation: "auto", network: { "example.com": true }, process: { spawn: false, run: true } },
        })
        await capsule.boot()
        const out = await capsule.run(`
            let r = "blocked"
            try {
                const res = await fetch("https://example.com", { signal: AbortSignal.timeout(6000) })
                r = res.ok ? "reached" : "reached"
            } catch (e) { r = "blocked:" + e.message }
            r
        `, { timeout: 10_000 })
        expect(out).toBe("reached")
        await capsule.shutdown()
    })
})
