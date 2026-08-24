import { Capsule } from "@axon/capsule"
import { tmpdir } from "os"

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
 */
describe("Capsule cwd reporting", () => {
    it("emits capsule:cwd when a command changes the working directory", async () => {
        const capsule = Capsule()
        const cwds: string[] = []
        capsule.on("capsule:cwd", e => cwds.push(e.cwd))
        await capsule.boot()

        const target = tmpdir()
        await capsule.run(`process.chdir(${JSON.stringify(target)})`)

        expect(cwds).toHaveLength(1)
        expect(cwds[0]).toBe(target)

        await capsule.shutdown()
    })

    it("stays silent when a command leaves the working directory alone", async () => {
        const capsule = Capsule()
        const cwds: string[] = []
        capsule.on("capsule:cwd", e => cwds.push(e.cwd))
        await capsule.boot()

        await capsule.run(`1 + 1`)

        expect(cwds).toHaveLength(0)

        await capsule.shutdown()
    })

    it("reports the move even when the command then throws", async () => {
        const capsule = Capsule()
        const cwds: string[] = []
        capsule.on("capsule:cwd", e => cwds.push(e.cwd))
        await capsule.boot()

        const target = tmpdir()
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
