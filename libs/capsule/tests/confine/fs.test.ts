import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Capsule } from "@axon/capsule"
import { probe } from "../../platform/confine/probe"

/**
 * Tier 2 — real escape attempts against a confined capsule on this host. Each
 * test IS the attack: boot the box, run the escape through the public API,
 * assert it fails. Skipped automatically where rootless confinement is
 * unavailable (non-Linux, or bwrap/systemd missing) so the suite stays green
 * everywhere; on a capable host it proves the wall holds.
 */
const boxed = probe().auto ? it : it.skip

async function confined() {
    const capsule = Capsule({ policy: { isolation: "auto", process: { spawn: false, run: true } } })
    await capsule.boot()
    return capsule
}

describe("Confinement — filesystem", () => {
    boxed("cannot read a secret outside the box", async () => {
        const capsule = await confined()
        const out = await capsule.run(`
            const { readFileSync } = await import("node:fs")
            let r = "blocked"
            try { readFileSync("/etc/shadow", "utf8"); r = "LEAKED" } catch { r = "blocked" }
            r
        `)
        expect(out).toBe("blocked")
        await capsule.shutdown()
    })

    boxed("cannot read another user's home directory", async () => {
        const capsule = await confined()
        const out = await capsule.run(`
            const { readdirSync } = await import("node:fs")
            let r = "blocked"
            try { readdirSync("/root"); r = "LEAKED" } catch { r = "blocked" }
            r
        `)
        expect(out).toBe("blocked")
        await capsule.shutdown()
    })

    boxed("can read and write inside its cwd", async () => {
        const capsule = await confined()
        const out = await capsule.run(`
            const { writeFileSync, readFileSync } = await import("node:fs")
            writeFileSync("./confine-probe.txt", "hi")
            readFileSync("./confine-probe.txt", "utf8")
        `)
        expect(out).toBe("hi")
        await capsule.shutdown()
    })

    boxed("cannot write to read-only system directories", async () => {
        const capsule = await confined()
        const out = await capsule.run(`
            const { writeFileSync } = await import("node:fs")
            let r = "blocked"
            try { writeFileSync("/usr/should-not-write", "x"); r = "WROTE" } catch { r = "blocked" }
            r
        `)
        expect(out).toBe("blocked")
        await capsule.shutdown()
    })

    // The over-grant guard, end to end: an fs policy scoped to ./workspace must
    // hide a SIBLING ./secret that lives under the same invocation cwd. Before
    // the bindCwd fix the always-on cwd bind exposed it despite the policy.
    boxed("hides a sibling secret under cwd when fs scopes to a subfolder", async () => {
        const root = mkdtempSync(join(tmpdir(), "confine-scope-"))
        mkdirSync(join(root, "workspace"))
        mkdirSync(join(root, "secret"))
        writeFileSync(join(root, "workspace", "ok.txt"), "visible")
        writeFileSync(join(root, "secret", "keys.txt"), "SECRET")

        const capsule = Capsule({
            cwd: root,
            policy: { isolation: "auto", fs: { read: [join(root, "workspace")], write: [join(root, "workspace")] }, process: { spawn: false, run: true } },
        })
        await capsule.boot()

        const secret = await capsule.run(`
            const { readFileSync } = await import("node:fs")
            let r = "blocked"
            try { r = readFileSync(${JSON.stringify(join(root, "secret", "keys.txt"))}, "utf8") } catch { r = "blocked" }
            r
        `)
        const allowed = await capsule.run(`
            const { readFileSync } = await import("node:fs")
            readFileSync(${JSON.stringify(join(root, "workspace", "ok.txt"))}, "utf8")
        `)

        expect(secret).toBe("blocked")
        expect(allowed).toBe("visible")

        await capsule.shutdown()
        rmSync(root, { recursive: true, force: true })
    })
})
