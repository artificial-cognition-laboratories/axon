import { Axon } from "../../setup/axon"

describe("kernel capsule cwd", () => {
    it("inherits the runtime invocation directory instead of the agent project root", async () => {
        const runtime = await Axon({ cwd: "/tmp" })

        expect((await runtime.kernel.run("process.cwd()")).value).toBe("/tmp")
        const attached = runtime.session.log.find(e => e.type === "capsule:attach")
        expect(attached?.data.cwd).toBe("/tmp")

        await runtime.shutdown()
    })

    it("retains the invocation directory across a reload when the agent never changed it", async () => {
        const runtime = await Axon({ cwd: "/tmp" })

        await runtime.update({})

        expect((await runtime.kernel.run("process.cwd()")).value).toBe("/tmp")
        const attachments = runtime.session.log.filter(e => e.type === "capsule:attach")
        expect(attachments).toHaveLength(2)
        expect(attachments.every(e => e.data.cwd === "/tmp")).toBe(true)

        await runtime.shutdown()
    })

    it("carries a mid-session chdir() across a reload instead of resetting to the invocation directory", async () => {
        const runtime = await Axon({ cwd: "/tmp" })

        await runtime.kernel.run('process.chdir("/")')
        expect(await runtime.kernel.run("process.cwd()")).toBe("/")

        await runtime.update({})

        // Reload replaces the capsule process — without carrying the live
        // cwd forward, this would silently reset to the original /tmp
        // invocation directory, breaking the "cwd persists across blocks"
        // contract declarations.ts promises the model.
        expect(await runtime.kernel.run("process.cwd()")).toBe("/")
        const attachments = runtime.kernel.log.filter(e => e.type === "capsule:attach")
        expect(attachments).toHaveLength(2)
        expect(attachments[0]!.data.cwd).toBe("/tmp")
        expect(attachments[1]!.data.cwd).toBe("/")

        await runtime.shutdown()
    })
})
