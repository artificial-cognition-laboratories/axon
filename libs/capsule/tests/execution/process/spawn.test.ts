import { Capsule } from "@axon/capsule"

describe("Capsule proc.spawn / process.spawn", () => {
    describe("via capsule.proc.spawn (host-initiated)", () => {
        it("spawns a real process and reflects its output and exit", async () => {
            const capsule = Capsule({ policy: { process: { spawn: true } } })
            await capsule.boot()

            const proc = capsule.process.spawn("echo hello")
            const exited = await proc.exited

            expect(exited.ok).toBe(true)
            expect(exited.exitCode).toBe(0)
            expect(exited.stdout).toBe("hello\n")
            expect(proc.status).toBe("exited")

            await capsule.shutdown()
        })

        it("captures stdout incrementally via tail()", async () => {
            const capsule = Capsule({ policy: { process: { spawn: true } } })
            await capsule.boot()

            const proc = capsule.process.spawn("printf 'a\\nb\\nc\\n'")
            await proc.exited

            expect(proc.tail(2)).toBe("b\nc\n")

            await capsule.shutdown()
        })

        it("resolves waitFor() once a matching line appears", async () => {
            const capsule = Capsule({ policy: { process: { spawn: true } } })
            await capsule.boot()

            const proc = capsule.process.spawn("sh -c 'sleep 0.05; echo ready-now'")
            const { line } = await proc.waitFor("ready-now", { timeoutMs: 2_000 })

            expect(line).toBe("ready-now")

            await capsule.shutdown()
        })

        it("kill() terminates a still-running process", async () => {
            const capsule = Capsule({ policy: { process: { spawn: true } } })
            await capsule.boot()

            const proc = capsule.process.spawn("sleep 30")
            expect(proc.status).toBe("running")

            proc.kill()
            const exited = await proc.exited

            expect(exited.ok).toBe(false)

            await capsule.shutdown()
        })

        it("is denied when process.spawn has no policy rule for it — the process never runs", async () => {
            const capsule = Capsule() // no policy at all
            await capsule.boot()

            const proc = capsule.process.spawn("echo should-not-run")
            const exited = await proc.exited

            expect(exited.ok).toBe(false)
            expect(exited.exitCode).toBe(-1)
            expect(exited.stdout).toBe("")

            await capsule.shutdown()
        })
    })

    describe("via process.spawn (in-sandbox)", () => {
        it("spawns a real process and returns a live handle", async () => {
            const capsule = Capsule({ policy: { process: { spawn: true } } })
            await capsule.boot()

            const result = await capsule.run(`
                const proc = process.spawn("echo hello-from-sandbox")
                await proc.exited
            `)

            expect(result).toEqual({ exitCode: 0, ok: true, stdout: "hello-from-sandbox\n" })

            await capsule.shutdown()
        })

        it("is mediated the same as capsule.proc.spawn()", async () => {
            const capsule = Capsule() // no process policy — default deny
            await capsule.boot()

            const result = await capsule.run(`
                const proc = process.spawn("echo should-not-run")
                await proc.exited
            `)

            expect(result).toEqual({ exitCode: -1, ok: false, stdout: "" })

            await capsule.shutdown()
        })
    })
})
