import { Capsule } from "@arcforge/capsule"
import type { ProcRunResult } from "@arcforge/capsule"

describe("Capsule process.run — blocking inline shell execution", () => {
    it("runs a command and returns its stdout, exit code, and ok", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"] } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo hello")`)

        expect(result).toEqual({ ok: true, exitCode: 0, stdout: "hello\n", stderr: "" })

        await capsule.shutdown()
    })

    it("never throws — a failing command resolves with ok: false and the real exit code", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"] } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("exit 7")`)

        expect(result).toEqual({ ok: false, exitCode: 7, stdout: "", stderr: "" })

        await capsule.shutdown()
    })

    it("captures stderr separately from stdout", async () => {
        // `raw: true` because `;` and `>&2` ARE shell syntax — this command is
        // a shell program, not one call, and the policy now says so. Without
        // it the run escalates, which is the correct answer to "may this agent
        // execute an arbitrary shell line".
        const capsule = Capsule({ policy: { shell: { allow: ["*"], raw: true } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo out; echo err >&2")`) as ProcRunResult

        expect(result.stdout).toBe("out\n")
        expect(result.stderr).toBe("err\n")
        expect(result.ok).toBe(true)

        await capsule.shutdown()
    })

    it("respects the cwd option", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"] } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("pwd", { cwd: "/tmp" })`) as ProcRunResult

        expect(result.stdout.trim()).toBe("/tmp")

        await capsule.shutdown()
    })

    it("merges the env option over the inherited environment", async () => {
        // `$CUSTOM_VAR` is expanded by the SHELL, so this is a shell program
        // too — see the stderr test above.
        const capsule = Capsule({ policy: { shell: { allow: ["*"], raw: true } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo $CUSTOM_VAR", { env: { CUSTOM_VAR: "hello-env" } })`) as ProcRunResult

        expect(result.stdout.trim()).toBe("hello-env")

        await capsule.shutdown()
    })

    it("writes the input option to stdin", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"] } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("cat", { input: "piped through stdin" })`) as ProcRunResult

        expect(result.stdout).toBe("piped through stdin")

        await capsule.shutdown()
    })

    it("is denied by policy — ok: false with err set, no cmd:* event bookkeeping leaks through", async () => {
        const capsule = Capsule() // no process policy — default deny
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo should-not-run")`) as ProcRunResult

        expect(result.ok).toBe(false)
        expect(result.err).toBe("denied by policy")
        expect(result.stdout).toBe("")

        await capsule.shutdown()
    })

    it("mirrors the blocking command as an observable ephemeral process", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"] } } })
        await capsule.boot()

        await capsule.run(`await process.run("echo one-shot")`)

        const [process] = capsule.process.list()
        expect(process?.kind).toBe("run")
        expect(process?.status).toBe("exited")
        expect(process?.stdout()).toContain("one-shot")

        await capsule.shutdown()
    })
})
