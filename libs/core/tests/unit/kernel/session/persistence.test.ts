import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Axon } from "../../../setup/axon"

describe("kernel: persistence", () => {
    it("resuming the same session restores prior entry history", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axon-test-"))
        const sessionId = crypto.randomUUID()

        const first = await Axon({ blueprint: { session: { id: sessionId }, paths: { root } } })
        await first.session.commitEntry("cognet:stimulus:text", { source: { channel: "user" }, content: "remember this" })
        await first.shutdown()

        const resumed = await Axon({ blueprint: { session: { id: sessionId }, paths: { root } } })

        const contents = resumed.session.entries.map(e => (e.data as { content: string }).content)
        expect(contents).toEqual(["remember this"])

        await resumed.shutdown()
        await rm(root, { recursive: true, force: true })
    })

    it("a fresh session starts with an empty entry log", async () => {
        const runtime = await Axon()

        expect(runtime.session.entries).toEqual([])

        await runtime.shutdown()
    })

    it("seq continues from the restored high-water mark, not from zero", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axon-test-"))
        const sessionId = crypto.randomUUID()

        const first = await Axon({ blueprint: { session: { id: sessionId }, paths: { root } } })
        await first.session.commitEntry("cognet:stimulus:text", { source: { channel: "user" }, content: "one" })
        await first.session.commitEntry("cognet:stimulus:text", { source: { channel: "user" }, content: "two" })
        await first.shutdown()

        const resumed = await Axon({ blueprint: { session: { id: sessionId }, paths: { root } } })
        const newEntry = await resumed.session.commitEntry("cognet:stimulus:text", { source: { channel: "user" }, content: "three" })

        const seqs = resumed.session.entries.map(e => e.time.seq)
        expect(new Set(seqs).size).toBe(seqs.length) // no seq collision with restored entries
        expect(newEntry.time.seq).toBeGreaterThan(1)

        await resumed.shutdown()
        await rm(root, { recursive: true, force: true })
    })
})
