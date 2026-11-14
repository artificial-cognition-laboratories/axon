import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Retention } from "../../src/retention"

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

/** A session of `bytes` frames, last written `daysAgo`; a conversation when someone typed to it. */
async function session(root: string, id: string, daysAgo: number, opts: { bytes?: number; conversation?: boolean } = {}): Promise<void> {
    const at = (NOW - daysAgo * DAY) / 1000
    const log = path.join(root, "sessions", `${id}.jsonl`)
    await mkdir(path.dirname(log), { recursive: true })
    const said = opts.conversation ? '{"type":"cognet:stimulus:text","data":{"content":"hello"}}\n' : '{"type":"cognet:stimulus:vector"}\n'
    await writeFile(log, '{"type":"session:header"}\n' + said)
    const media = path.join(root, "media", id)
    await mkdir(media, { recursive: true })
    await writeFile(path.join(media, "0000000000.jpg"), "x".repeat(opts.bytes ?? 10))
    for (const target of [log, path.join(media, "0000000000.jpg"), media]) await utimes(target, at, at)
}

describe("retention", () => {
    it("removes whole sessions last written more than three days ago, and keeps the rest", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axon-retention-"))
        await session(root, "old", 5)
        await session(root, "recent", 1)
        const retention = Retention({ root: root })
        const plan = await retention.plan({ now: NOW })
        expect(plan.going.map(going => [going.id, going.why])).toEqual([["old", "age"]])
        await retention.apply(plan)
        expect(existsSync(path.join(root, "sessions", "old.jsonl"))).toBe(false)
        expect(existsSync(path.join(root, "media", "old"))).toBe(false)
        expect(existsSync(path.join(root, "sessions", "recent.jsonl"))).toBe(true)
    })

    it("keeps a conversation's log, whatever its age: what a person said is not disk space", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axon-retention-"))
        await session(root, "talked", 30, { conversation: true })
        const retention = Retention({ root: root })
        await retention.apply(await retention.plan({ now: NOW }))
        expect(existsSync(path.join(root, "sessions", "talked.jsonl"))).toBe(true)
        expect(existsSync(path.join(root, "media", "talked"))).toBe(false)
    })

    it("counts an agent that only answered as a conversation too", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axon-retention-"))
        await session(root, "answered", 30)
        await writeFile(path.join(root, "sessions", "answered.jsonl"), '{"type":"cognet:output:text","data":{"content":"hi"}}\n', { flag: "a" })
        await utimes(path.join(root, "sessions", "answered.jsonl"), (NOW - 30 * DAY) / 1000, (NOW - 30 * DAY) / 1000)
        const plan = await Retention({ root: root }).plan({ now: NOW })
        expect(plan.going.map(going => [going.id, going.conversation])).toEqual([["answered", true]])
    })

    it("over the budget, removes the oldest until it fits — never the session opening", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axon-retention-"))
        await session(root, "a", 2, { bytes: 400 })
        await session(root, "b", 1.5, { bytes: 400 })
        await session(root, "c", 1, { bytes: 400 })
        await session(root, "opening", 2.5, { bytes: 400 })
        const plan = await Retention({ root: root }).plan({ now: NOW, current: "opening", bytes: 1_000 })
        expect(plan.going.map(going => [going.id, going.why])).toEqual([["a", "budget"], ["b", "budget"]])
        expect(plan.bytes).toBeLessThanOrEqual(1_000)
    })

    it("never touches a session written in the last few minutes: it may be running elsewhere", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "axon-retention-"))
        await session(root, "live", 1 / (24 * 60))
        expect((await Retention({ root: root }).plan({ now: NOW, days: 0 })).going).toEqual([])
    })
})
