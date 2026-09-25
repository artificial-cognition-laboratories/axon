import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { sessionHasEntries, isListableSession } from "@arcforge/platform/build/runtime"
import { ENTRY_EVENT_PREFIXES } from "@arcforge/types"

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function session(lines: unknown[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-session-record-"))
    roots.push(root)
    const file = join(root, "session.jsonl")
    await writeFile(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n")
    return file
}

describe("session palette records", () => {
    test("does not treat lifecycle-only logs as conversations", async () => {
        const file = await session([
            { type: "axon:session:opened", data: {} },
            { type: "axon:boot:complete", data: {} },
            { type: "axon:session:closed", data: {} },
        ])

        expect(sessionHasEntries(file)).toBe(false)
    })

    test("recognizes a durable conversation entry", async () => {
        const file = await session([
            { type: "axon:session:opened", data: {} },
            { type: "cognet:stimulus:text", data: { content: "hello" } },
        ])

        expect(sessionHasEntries(file)).toBe(true)
    })

    /**
     * Every registered entry family counts, not a hand-picked subset.
     *
     * This is the test the previous implementation could not pass. The marker
     * list was written out by hand and drifted from the registry, so a log
     * whose only entry was `axon:agent:done` reported no entries and was
     * filtered out of every listing — a session that ran, invisible. Driving
     * the case list from ENTRY_EVENT_PREFIXES means adding a family to the
     * registry without teaching this function about it fails here.
     */
    test("recognizes an entry from every registered entry family", async () => {
        for (const prefix of ENTRY_EVENT_PREFIXES) {
            // A prefix is either a namespace ("cognet:output:") or a whole
            // type ("axon:interrupt"); suffixing the namespaces gives a
            // concrete type either way.
            const type = prefix.endsWith(":") ? `${prefix}text` : prefix
            const file = await session([
                { type: "axon:session:opened", data: {} },
                { type, data: {} },
            ])

            expect(sessionHasEntries(file)).toBe(true)
        }
    })

    test("scans past the first read buffer to find a late entry", async () => {
        // The scan reads in 64KB chunks and carries an overlap between them,
        // so an entry beyond the first buffer — and one straddling the seam —
        // must still be found. A conversation that opens with a long build
        // preamble is the ordinary case for this.
        const filler = Array.from({ length: 4000 }, (_, index) => ({
            type: "build:load:complete",
            data: { index, padding: "x".repeat(40) },
        }))
        const file = await session([
            { type: "axon:session:opened", data: {} },
            ...filler,
            { type: "cognet:output:text", data: { content: "hello" } },
        ])

        expect(sessionHasEntries(file)).toBe(true)
    })
})

/**
 * The listing rule Fleet's shelf and the TUI's `^` palette both apply.
 *
 * There IS an integration test covering the hasEntries half
 * (tests/integration/runtime/sessions.test.ts), but it spawns a real agent and
 * calls a provider, so it needs credentials and does not run everywhere. The
 * rule it guards needs neither — so it is pinned here too, where it always
 * runs. That the integration test was red for an unrelated auth reason is
 * exactly how the marker-list drift reached a release unnoticed.
 */
describe("isListableSession", () => {
    const record = (over: Partial<Parameters<typeof isListableSession>[0]> = {}) => ({
        hasEntries: false,
        running: false,
        forkedFrom: null,
        ...over,
    })

    test("lists a session that holds a conversation", () => {
        expect(isListableSession(record({ hasEntries: true }))).toBe(true)
    })

    test("hides a log that was opened and never spoken into", () => {
        expect(isListableSession(record())).toBe(false)
    })

    test("lists a RUNNING session before anyone has spoken into it", () => {
        // The conversation being had right now. It boots with a header and
        // build events and nothing else, so hasEntries alone hid it from its
        // own history until the first message was typed.
        expect(isListableSession(record({ running: true }))).toBe(true)
    })

    test("lists a fork, which is an explicit act even when empty", () => {
        expect(isListableSession(record({ forkedFrom: "parent" }))).toBe(true)
    })
})
