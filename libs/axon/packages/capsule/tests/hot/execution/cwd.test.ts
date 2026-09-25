import { Capsule } from "@arcforge/capsule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * capsule:cwd — the sandbox reports its working directory whenever a command
 * moves it.
 *
 * This backs a real continuity contract: "cwd changes persist across blocks"
 * holds within one incarnation, but a reload starts a fresh process. The host
 * tracks cwd from this stream so the incoming capsule can be configured where
 * the outgoing one actually was. Previously the kernel recovered it by
 * executing `process.cwd()` inside the dying incarnation at reload time — a
 * query that could fail and silently leave a stale value.
 *
 * The target is a FRESH directory per run, not `tmpdir()` itself. Using
 * tmpdir() made these tests assume the runner's own cwd is never /tmp — so
 * `bun test` invoked from /tmp chdir'd the sandbox to where it already was,
 * emitted no capsule:cwd (correctly — nothing moved), and failed. That read as
 * flakiness because it depended on where the suite happened to be launched
 * from; a directory that cannot already be the cwd removes the assumption.
 */
describe("Capsule cwd reporting", () => {
    let target: string
    beforeEach(() => { target = mkdtempSync(join(tmpdir(), "axon-cwd-")) })
    afterEach(() => rmSync(target, { recursive: true, force: true }))

    it("emits capsule:cwd when a command changes the working directory", async () => {
        const capsule = Capsule()
        const cwds: string[] = []
        capsule.on("process:cwd", e => cwds.push(e.cwd))
        await capsule.boot()

        await capsule.run(`process.chdir(${JSON.stringify(target)})`)

        expect(cwds).toHaveLength(1)
        expect(cwds[0]).toBe(target)

        await capsule.shutdown()
    })

    it("stays silent when a command leaves the working directory alone", async () => {
        const capsule = Capsule()
        const cwds: string[] = []
        capsule.on("process:cwd", e => cwds.push(e.cwd))
        await capsule.boot()

        await capsule.run(`1 + 1`)

        expect(cwds).toHaveLength(0)

        await capsule.shutdown()
    })

    it("reports the move even when the command then throws", async () => {
        const capsule = Capsule()
        const cwds: string[] = []
        capsule.on("process:cwd", e => cwds.push(e.cwd))
        await capsule.boot()

        // The process really did move — a failure after the chdir must not
        // lose that fact, or the host tracks a directory the sandbox left.
        await expect(
            capsule.run(`process.chdir(${JSON.stringify(target)}); throw new Error("after")`),
        ).rejects.toThrow()

        expect(cwds).toHaveLength(1)
        expect(cwds[0]).toBe(target)

        await capsule.shutdown()
    })
})
