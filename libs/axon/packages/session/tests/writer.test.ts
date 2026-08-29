import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AxonSession } from "../src/session"
import { AxonBus } from "@arcforge/core"

/**
 * One session file, one writer.
 *
 * The Writer in session.ts exists to make "line order IS the session's total
 * order" true — it serializes appends behind a single queue so disk order is
 * commit order. That invariant assumes there is only one of it per file.
 *
 * There were two. A confined agent built its own `AxonSession` over the same
 * path the supervisor had already opened, so every entry was written twice by
 * writers with independent seq counters, and the log carried interleaved
 * streams whose sequence numbers ran BACKWARDS (…49, 20, 51, 21…). Anything
 * counting entries read double; anything trusting seq order read nonsense.
 *
 * `persist: false` is what resolves it: the agent keeps its in-memory
 * projections and its bus announcements — it still needs to read its own
 * conversation back, and the supervisor learns of every commit through the
 * link — and only the append is suppressed.
 */

function blueprint(root: string, sessionId: string) {
    return {
        agent: { name: "@test/agent", version: "0.0.0" },
        paths: { root, data: "data" },
        session: { id: sessionId },
        env: {},
    } as never
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-session-writer-"))
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function lines(root: string, sessionId: string): unknown[] {
    const file = join(root, "data", "sessions", `${sessionId}.jsonl`)
    return readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as { type: string })
        .filter(entry => entry.type !== "session:header")
}

describe("session persistence — one file, one writer", () => {
    it("a persisting session writes what it commits", async () => {
        const f = await fixture()
        const session = await AxonSession({ blueprint: blueprint(f.root, "s1"), bus: AxonBus() } as never)

        await session.commit("axon:boot:start", {} as never)
        await session.end()

        const written = lines(f.root, "s1").map(e => (e as { type: string }).type)
        expect(written).toContain("axon:boot:start")
        expect(written.filter(t => t === "axon:session:closed")).toHaveLength(1)

        await f.cleanup()
    })

    it("a NON-persisting session writes nothing at all", async () => {
        // The agent's side. Its commits reach the record through the link,
        // never through its own file handle.
        const f = await fixture()
        const session = await AxonSession({
            blueprint: blueprint(f.root, "s2"),
            bus: AxonBus(),
            persist: false,
        } as never)

        await session.commit("axon:boot:start", {} as never)
        await session.end()

        // The file is opened (a header is written when the session is
        // created), but nothing is APPENDED to it.
        expect(lines(f.root, "s2")).toEqual([])

        await f.cleanup()
    })

    it("a non-persisting session still announces on its bus", async () => {
        // The forwarding path depends on this: suppressing the append must
        // not suppress the announcement, or the supervisor never hears about
        // the commit and the entry is lost rather than deduplicated.
        const f = await fixture()
        const bus = AxonBus()
        const heard: string[] = []
        bus.onAny((type: string) => { heard.push(type) })

        const session = await AxonSession({
            blueprint: blueprint(f.root, "s3"),
            bus,
            persist: false,
        } as never)
        await session.commit("axon:boot:start", {} as never)

        expect(heard).toContain("axon:boot:start")

        await f.cleanup()
    })

    it("a non-persisting session does not record its own closing", async () => {
        // `end()` records `axon:session:closed`, which is a fact about the
        // RECORD. A projection closing is not that fact — committing it put
        // two of them in one log, the agent's forwarded and the supervisor's
        // own.
        const f = await fixture()
        const bus = AxonBus()
        const heard: string[] = []
        bus.onAny((type: string) => { heard.push(type) })

        const session = await AxonSession({
            blueprint: blueprint(f.root, "s4"),
            bus,
            persist: false,
        } as never)
        await session.end()

        expect(heard).not.toContain("axon:session:closed")

        await f.cleanup()
    })
})
