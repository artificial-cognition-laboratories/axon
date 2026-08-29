import { Axon } from "../../setup/axon"

/**
 * These MOVE THE PROCESS, and must put it back.
 *
 * cwd used to belong to the capsule's own subprocess: a test could chdir it
 * freely and the directory died with the process. The capsule runs in this
 * heap now, so `process.chdir()` moves the test runner itself — and a file
 * that leaves the process somewhere else takes every later suite with it.
 * The HTTP server tests resolve fixture paths relative to cwd and failed en
 * masse, which read as flakiness and was simply this file not tidying up.
 *
 * The capsule restores the cwd it entered with on shutdown; this covers the
 * case where a test asserts a chdir and then fails before shutting down.
 */
describe("kernel capsule cwd", () => {
    const entry = process.cwd()
    afterEach(() => {
        if (process.cwd() !== entry) process.chdir(entry)
    })

    it("inherits the runtime invocation directory instead of the agent project root", async () => {
        const runtime = await Axon({ cwd: "/tmp" })

        expect((await runtime.kernel.run("process.cwd()")).value).toBe("/tmp")
        const attached = runtime.session.log.find(e => e.type === "process:attach")
        expect(attached?.data.cwd).toBe("/tmp")

        await runtime.shutdown()
    })

    it("retains the invocation directory across a reload when the agent never changed it", async () => {
        const runtime = await Axon({ cwd: "/tmp" })

        await runtime.update({})

        expect((await runtime.kernel.run("process.cwd()")).value).toBe("/tmp")
        const attachments = runtime.session.log.filter(e => e.type === "process:attach")
        expect(attachments).toHaveLength(2)
        expect(attachments.every(e => e.data.cwd === "/tmp")).toBe(true)

        await runtime.shutdown()
    })

    it("carries a mid-session chdir() across a reload instead of resetting to the invocation directory", async () => {
        const runtime = await Axon({ cwd: "/tmp" })

        await runtime.kernel.run('process.chdir("/")')
        expect((await runtime.kernel.run("process.cwd()")).value).toBe("/")

        await runtime.update({})

        // Reload replaces the capsule process — without carrying the live
        // cwd forward, this would silently reset to the original /tmp
        // invocation directory, breaking the "cwd persists across blocks"
        // contract declarations.ts promises the model.
        expect((await runtime.kernel.run("process.cwd()")).value).toBe("/")
        const attachments = runtime.session.log.filter(e => e.type === "process:attach")
        expect(attachments).toHaveLength(2)
        expect(attachments[0]!.data.cwd).toBe("/tmp")
        expect(attachments[1]!.data.cwd).toBe("/")

        await runtime.shutdown()
    })
})
