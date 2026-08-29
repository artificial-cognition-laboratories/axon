import { Capsule } from "@arcforge/capsule"
import type { ProcRunResult } from "@arcforge/capsule"

/**
 * `process.run()` is the model-facing API; `shell` is the policy that gates it.
 *
 * The two names differ deliberately. The scope global stays `process.run`
 * because that is what Node calls it and the model writes ordinary TypeScript.
 * The POLICY names the capability — shell access — because that is what a user
 * is granting, and because the rule now decides on the PROGRAM rather than by
 * glob-matching the command string.
 */
describe("Capsule policy — shell gates process.run", () => {
    it("allows a program the policy names", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["echo"] } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo hello")`) as ProcRunResult
        expect(result.ok).toBe(true)

        await capsule.shutdown()
    })

    it("denies every program when the surface is off", async () => {
        const capsule = Capsule({ policy: { shell: false } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo hello")`) as ProcRunResult
        expect(result.ok).toBe(false)
        // The REASON, not just "denied" — a model can act on the difference.
        // `shell: false` expands to an explicit deny-everything, so the denial
        // names the denylist rather than the (empty) allowlist.
        expect(result.err).toContain("shell.deny")

        await capsule.shutdown()
    })

    it("denies a program the allowlist does not name", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["echo"] } } })
        await capsule.boot()

        const denied = await capsule.run(`await process.run("cat /etc/passwd")`) as ProcRunResult
        expect(denied.ok).toBe(false)
        expect(denied.err).toContain("cat")

        await capsule.shutdown()
    })

    it("deny beats allow for the same program", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["echo"], deny: ["echo"] } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo hi")`) as ProcRunResult
        expect(result.ok).toBe(false)

        await capsule.shutdown()
    })

    it("gates arguments once the program itself is admitted", async () => {
        const capsule = Capsule({
            policy: { shell: { allow: ["echo"], args: { echo: { deny: ["secret*"] } } } },
        })
        await capsule.boot()

        const ok = await capsule.run(`await process.run("echo fine")`) as ProcRunResult
        const no = await capsule.run(`await process.run("echo secret stuff")`) as ProcRunResult
        expect(ok.ok).toBe(true)
        expect(no.ok).toBe(false)

        await capsule.shutdown()
    })

    /**
     * The bypasses the old command-string glob admitted. Each names the same
     * binary by a spelling `allow: ["echo *"]` did not describe.
     */
    describe("spellings that used to defeat the matcher", () => {
        const boxed = (code: string) => Capsule({ policy: { shell: { allow: ["echo"] } } })

        it("denies a shell even when it would run an allowed program", async () => {
            const capsule = boxed("")
            await capsule.boot()
            const result = await capsule.run(`await process.run("sh -c 'echo hi'")`) as ProcRunResult
            expect(result.ok).toBe(false)
            expect(result.err).toContain("raw shell")
            await capsule.shutdown()
        })

        it("denies a disallowed program laundered through env", async () => {
            const capsule = boxed("")
            await capsule.boot()
            const result = await capsule.run(`await process.run("env cat /etc/passwd")`) as ProcRunResult
            expect(result.ok).toBe(false)
            await capsule.shutdown()
        })

        it("admits an allowed program however it is spelled", async () => {
            const capsule = boxed("")
            await capsule.boot()
            const spaced = await capsule.run(`await process.run("echo  hi")`) as ProcRunResult
            expect(spaced.ok).toBe(true)
            await capsule.shutdown()
        })
    })
})
