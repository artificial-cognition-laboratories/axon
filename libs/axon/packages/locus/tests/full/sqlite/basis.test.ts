import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Locus } from "../../../src"
import { Space, from } from "../../../src/pure"
import { AXES, grownSpace, testSpace } from "../../space"

const dirs: string[] = []

function dbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "locus-"))
    dirs.push(dir)
    return join(dir, "memory.db")
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("basis", () => {
    test("a fresh store adopts the declared space", async () => {
        const locus = await Locus({ space: testSpace(), conn: { type: "sqlite", path: dbPath() } })
        expect(locus.basis.version).toBe(testSpace().version)
        expect(locus.basis.ordinal).toBe(1)
        expect(locus.basis.axes).toEqual(AXES.map(axis => axis.name))
        await locus.close()
    })

    test("reopening with the same space succeeds", async () => {
        const path = dbPath()
        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        await first.close()

        const second = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        expect(second.basis.version).toBe(testSpace().version)
        await second.close()
    })

    test("a DRIFTED axis table is refused at boot, before a float is interpreted", async () => {
        const path = dbPath()
        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        await first.records.put({ coord: from(first.space, { threat: 0.8 }) })
        await first.close()

        await expect(Locus({ space: grownSpace(), conn: { type: "sqlite", path: path } })).rejects.toThrow(
            /Does Not Match|basis/
        )
    })

    test("a REDEFINED axis is refused even though the names are identical", async () => {
        const path = dbPath()
        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        await first.close()

        const reworded = Space({
            axes: AXES.map(axis => (axis.name === "threat" ? { ...axis, question: "Is this a threat to me?" } : axis)),
        })

        await expect(Locus({ space: reworded, conn: { type: "sqlite", path: path } })).rejects.toThrow(
            /Does Not Match|basis/
        )
    })

    test("changing only weight or metric is NOT a basis change", async () => {
        const path = dbPath()
        const first = await Locus({ space: testSpace(), conn: { type: "sqlite", path: path } })
        await first.close()

        const retuned = Space({ axes: AXES, domains: { risk: { weight: 7, metric: "cosine" } } })
        const second = await Locus({ space: retuned, conn: { type: "sqlite", path: path } })
        expect(second.basis.version).toBe(testSpace().version)
        await second.close()
    })
})

describe("connection", () => {
    test("remote is declared but throws rather than pretending", async () => {
        await expect(
            Locus({ space: testSpace(), conn: { type: "remote", url: "https://example.invalid" } })
        ).rejects.toThrow(/Not Wired Yet|remote/)
    })
})
