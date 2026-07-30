import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { home } from "../src/home"

/**
 * A session log survives a torn final line.
 *
 * appendFile is not atomic, so any hard kill mid-append (OOM, SIGKILL, power
 * loss) leaves a partial line on disk. Parsing strictly made that one line
 * destroy the whole session — every complete event before it lost too — for
 * the one piece of data in this system that cannot be rebuilt.
 */
describe("Session log recovery", () => {
    async function withLog(contents: string, fn: (root: string) => Promise<void>): Promise<void> {
        const root = await mkdtemp(join(tmpdir(), "axon-torn-log-"))
        try {
            await mkdir(join(root, "sessions"), { recursive: true })
            await writeFile(join(root, "sessions", "s1.jsonl"), contents)
            await fn(root)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }

    const good = (seq: number) => JSON.stringify({ type: "axon:session:opened", time: { seq } })

    it("keeps every complete event when the final line is torn", async () => {
        // exactly what a kill mid-append leaves behind
        await withLog(`${good(0)}\n${good(1)}\n{"type":"axon:boot:sta`, async root => {
            const events = await home.data.sessions.read(root, "s1")

            expect(events).toHaveLength(2)
            expect((events[0] as { time: { seq: number } }).time.seq).toBe(0)
            expect((events[1] as { time: { seq: number } }).time.seq).toBe(1)
        })
    })

    it("skips a corrupt line in the middle and keeps both sides", async () => {
        await withLog(`${good(0)}\nnot json at all\n${good(2)}`, async root => {
            const events = await home.data.sessions.read(root, "s1")

            // the gap is visible in seq — a reader can see 1 is missing
            expect(events.map(e => (e as { time: { seq: number } }).time.seq)).toEqual([0, 2])
        })
    })

    it("reads a clean log unchanged", async () => {
        await withLog(`${good(0)}\n${good(1)}\n${good(2)}\n`, async root => {
            const events = await home.data.sessions.read(root, "s1")
            expect(events).toHaveLength(3)
        })
    })

    it("returns nothing for an empty or absent log", async () => {
        await withLog("", async root => {
            expect(await home.data.sessions.read(root, "s1")).toEqual([])
            expect(await home.data.sessions.read(root, "never-existed")).toEqual([])
        })
    })
})
