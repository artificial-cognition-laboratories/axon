import { describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AxonSession } from "../../src/session"
import { AxonBus } from "@arcforge/core"

/**
 * Dense media never reaches the durable log, whichever door it comes through.
 *
 * The regression: an agent in a subprocess relays every event it announces to
 * its supervisor, which receives them through `commit()`. Only `ingest()` knew
 * the retention rule, so every camera frame went into the supervisor's log —
 * a Terraria agent wrote 7GB in an hour.
 */

function blueprint(root: string, sessionId: string) {
    return {
        agent: { name: "@test/agent", version: "0.0.0" },
        paths: { root, data: "data" },
        session: { id: sessionId },
        env: {},
    } as never
}

const FRAME = { channel: "/vision", ref: { uri: "data:image/jpeg;base64,AAAA", mime: "image/jpeg", bytes: 3 }, kind: "image" }

/** Every file under `dir`, recursively, with its text. */
async function files(dir: string): Promise<Array<{ path: string; text: string }>> {
    const out: Array<{ path: string; text: string }> = []
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue
        const path = join(entry.parentPath, entry.name)
        out.push({ path: path, text: await readFile(path, "utf-8") })
    }
    return out
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-retention-"))
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("sensory retention", () => {
    it("a frame committed through commit() — the supervisor's relay door — goes to the ring, not the log", async () => {
        const { root, cleanup } = await fixture()
        const bus = AxonBus()
        const heard: string[] = []
        bus.onAny((type: string) => { heard.push(type) })

        const session = await AxonSession({ blueprint: blueprint(root, "s1"), bus })
        await session.commit("cognet:stimulus:visual" as never, FRAME as never)
        await session.commitEntry("cognet:stimulus:visual" as never, FRAME as never)
        await session.end()

        const written = await files(root)
        const log = written.filter(file => file.path.includes("/sessions/"))
        const ring = written.filter(file => file.path.includes("/sensory/"))

        expect(log.some(file => file.text.includes("cognet:stimulus:visual"))).toBe(false)
        expect(ring.map(file => file.text).join("").split("cognet:stimulus:visual").length - 1).toBe(2)
        // Still observable live — retention is about the record, not the present.
        expect(heard.filter(type => type === "cognet:stimulus:visual")).toHaveLength(2)

        await cleanup()
    })

    it("a non-persisting session writes no ring — the supervisor it relays to owns the disk", async () => {
        const { root, cleanup } = await fixture()
        const projection = await AxonSession({ blueprint: blueprint(root, "s1"), bus: AxonBus(), persist: false })

        await projection.stimuli.ingest("cognet:stimulus:visual" as never, FRAME as never)
        await projection.end()

        const all = await files(root)
        expect(all.filter(file => file.path.includes("/sensory/")).map(file => file.path)).toEqual([])
        await cleanup()
    })

    it("keeps the symbolic layer durable", async () => {
        const { root, cleanup } = await fixture()
        const session = await AxonSession({ blueprint: blueprint(root, "s1"), bus: AxonBus() })

        await session.stimuli.ingest("cognet:stimulus:text", { channel: "terminal", content: "hello" } as never)
        await session.end()

        const log = (await files(root)).filter(file => file.path.includes("/sessions/"))
        expect(log.some(file => file.text.includes('"cognet:stimulus:text"'))).toBe(true)
        await cleanup()
    })
})
