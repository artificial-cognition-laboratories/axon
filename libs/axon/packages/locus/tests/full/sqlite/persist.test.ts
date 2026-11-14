import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Locus } from "../../../src"
import { from } from "../../../src/pure"
import { testSpace } from "../../space"

const dirs: string[] = []

function dbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "locus-"))
    dirs.push(dir)
    return join(dir, "memory.db")
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("sqlite durability", () => {
    test("records survive a reopen with their coordinates intact", async () => {
        const path = dbPath()

        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        const id = await first.records.put({
            coord: from(first.space, { threat: 0.8, noisy: 1 }),
            payload: { name: "slime" },
            at: 4242,
        })
        await first.close()

        const second = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        const record = await second.records.get(id)

        expect(record.coord.values[0]).toBeCloseTo(0.8, 5)
        expect(record.coord.values[2]).toBeCloseTo(1, 5)
        expect(record.at).toBe(4242)
        expect(record.payload).toEqual({ name: "slime" })
        await second.close()
    })

    test("UNMEASURED survives as unmeasured, not as zero", async () => {
        const path = dbPath()

        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        const id = await first.records.put({ coord: from(first.space, { threat: 0, noisy: 0.5 }) })
        await first.close()

        const second = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        const record = await second.records.get(id)

        // threat was measured AS zero; large was never measured. The blob must
        // keep those apart or every reloaded memory gains beliefs it never held.
        expect(record.coord.conf[0]).toBeGreaterThan(0)
        expect(record.coord.conf[3]).toBe(0)
        await second.close()
    })

    test("deletes survive a reopen", async () => {
        const path = dbPath()

        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        const id = await first.records.put({ coord: from(first.space, { threat: 0.5 }) })
        await first.records.delete(id)
        await first.close()

        const second = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        expect(second.records.count).toBe(0)
        await second.close()
    })

    test("queries work identically after a reload", async () => {
        const path = dbPath()

        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        for (let i = 0; i < 50; i++) {
            await first.records.put({ coord: from(first.space, { threat: i / 50, fragile: 0.5 }), at: i })
        }
        const before = await first.records.query({ where: { threat: { gt: 0.5 } } })
        await first.close()

        const second = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        const after = await second.records.query({ where: { threat: { gt: 0.5 } } })

        expect(after.hits).toHaveLength(before.hits.length)
        await second.close()
    })

    test("regions survive a reopen and still claim what they claimed", async () => {
        const path = dbPath()

        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        await first.regions.fitOf(
            "block",
            [from(first.space, { fragile: 1, threat: 0 }), from(first.space, { fragile: 0, threat: 1 })],
            { radius: 0.2, domain: "risk", spread: 0.3 }
        )
        await first.close()

        const second = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        const region = second.regions.get("block")

        expect(region.prototypes).toHaveLength(2)
        expect(region.domain).toBe("risk")
        expect(second.regions.has("block", from(second.space, { fragile: 0, threat: 1 }))).toBe(true)
        await second.close()
    })

    test("consolidation survives — the prototype is what reloads", async () => {
        const path = dbPath()

        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        for (let i = 0; i < 6; i++) {
            await first.records.put({ coord: from(first.space, { threat: 0.5 + i * 0.01, fragile: 0.5 }), at: i })
        }
        const report = await first.records.consolidate({ radius: 0.05, domain: "risk" })
        await first.close()

        const second = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        expect(second.records.count).toBe(report.after)
        await second.close()
    })
})
