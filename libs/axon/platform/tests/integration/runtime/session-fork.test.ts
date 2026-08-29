import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Sessions } from "@arcforge/platform/build/runtime"

/**
 * Forking and renaming a session — both act on ONE log, by path.
 *
 * A session log is append-only JSONL and self-contained: every event carries
 * its own context, nothing outside points into it. That is what makes a fork a
 * byte copy with a rewritten header — no index, no backend, offline, instant.
 * These tests pin that property, because the moment anything outside the file
 * has to be updated too, "copy the file" silently stops being correct.
 */

type Fixture = { dir: string; sessions: ReturnType<typeof Sessions> }

async function withSessions(fn: (ctx: Fixture) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "axon-test-fork-"))
    try {
        // list() needs a store to enumerate profiles; fork/rename take a path
        // and never touch it, which is the point of them being path-addressed.
        const sessions = Sessions({
            store: { profiles: { active: () => null } } as never,
            isRunning: () => false,
        })
        await fn({ dir, sessions })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

/** A session log: header line, then events. */
async function log(dir: string, sessionId: string, events: unknown[] = []): Promise<string> {
    const path = join(dir, `${sessionId}.jsonl`)
    const lines = [
        JSON.stringify({
            type: "session:header",
            version: 2,
            agentId: "@axon/zeno",
            sessionId,
            startedAt: "2026-01-01T00:00:00.000Z",
        }),
        ...events.map(event => JSON.stringify(event)),
    ]
    await writeFile(path, `${lines.join("\n")}\n`)
    return path
}

async function header(path: string): Promise<Record<string, unknown>> {
    const text = await readFile(path, "utf-8")
    return JSON.parse(text.slice(0, text.indexOf("\n"))) as Record<string, unknown>
}

describe("sessions.fork", () => {
    test("copies every event and gives the copy a new identity", async () => {
        await withSessions(async ({ dir, sessions }) => {
            const events = [
                { type: "cognet:stimulus:text", data: { content: "hello" } },
                { type: "cognet:output:text", data: { content: "hi" } },
            ]
            const source = await log(dir, "11111111-1111-1111-1111-111111111111", events)

            const forked = await sessions.fork(source)

            expect(forked.sessionId).not.toBe("11111111-1111-1111-1111-111111111111")

            // Identical content below the header — a fork is the same
            // conversation, not a summary of one.
            const copied = (await readFile(forked.filePath, "utf-8")).trim().split("\n").slice(1)
            const original = (await readFile(source, "utf-8")).trim().split("\n").slice(1)
            expect(copied).toEqual(original)

            const head = await header(forked.filePath)
            expect(head.sessionId).toBe(forked.sessionId)
            // Carried over: a fork of a zeno session is still a zeno session.
            expect(head.agentId).toBe("@axon/zeno")
        })
    })

    test("records where it came from", async () => {
        await withSessions(async ({ dir, sessions }) => {
            const source = await log(dir, "22222222-2222-2222-2222-222222222222")

            const forked = await sessions.fork(source)
            const head = await header(forked.filePath)

            // Lineage is written at the one moment it is free to know.
            // Reconstructing it later from timestamps and content would be
            // guesswork, and a fork with no parent is indistinguishable from
            // an ordinary session.
            expect(head.forkedFrom).toMatchObject({ sessionId: "22222222-2222-2222-2222-222222222222" })
        })
    })

    test("leaves the original untouched", async () => {
        await withSessions(async ({ dir, sessions }) => {
            const source = await log(dir, "33333333-3333-3333-3333-333333333333", [
                { type: "cognet:stimulus:text", data: { content: "hello" } },
            ])
            const before = await readFile(source, "utf-8")

            await sessions.fork(source)

            // The whole point of forking rather than branching: you continue
            // from the copy and what you had is still exactly what you had.
            expect(await readFile(source, "utf-8")).toBe(before)
        })
    })

    test("takes an optional title", async () => {
        await withSessions(async ({ dir, sessions }) => {
            const source = await log(dir, "44444444-4444-4444-4444-444444444444")
            const forked = await sessions.fork(source, { title: "experiment" })
            expect((await header(forked.filePath)).title).toBe("experiment")
        })
    })

    test("refuses a log with no header rather than producing a broken copy", async () => {
        await withSessions(async ({ dir, sessions }) => {
            const path = join(dir, "headerless.jsonl")
            await writeFile(path, `${JSON.stringify({ type: "cognet:output:text" })}\n`)

            // An older log can still be read and resumed — it just cannot be
            // copied, because there is no header to rewrite and the copy would
            // therefore claim its parent's id.
            await expect(sessions.fork(path)).rejects.toMatchObject({ code: "AX-SESSION-006" })
        })
    })

    test("reports a missing session rather than creating one", async () => {
        await withSessions(async ({ dir, sessions }) => {
            await expect(sessions.fork(join(dir, "nope.jsonl"))).rejects.toMatchObject({
                code: "AX-SESSION-005",
            })
        })
    })
})

describe("sessions.rename", () => {
    test("sets the title and keeps every event", async () => {
        await withSessions(async ({ dir, sessions }) => {
            const events = [{ type: "cognet:output:text", data: { content: "hi" } }]
            const path = await log(dir, "55555555-5555-5555-5555-555555555555", events)

            await sessions.rename(path, "the good one")

            const head = await header(path)
            expect(head.title).toBe("the good one")
            expect(head.sessionId).toBe("55555555-5555-5555-5555-555555555555")

            // The rewrite is header-only — renaming must never cost you the
            // conversation.
            const body = (await readFile(path, "utf-8")).trim().split("\n").slice(1)
            expect(body).toEqual(events.map(event => JSON.stringify(event)))
        })
    })

    test("renaming twice replaces rather than accumulates", async () => {
        await withSessions(async ({ dir, sessions }) => {
            const path = await log(dir, "66666666-6666-6666-6666-666666666666")
            await sessions.rename(path, "first")
            await sessions.rename(path, "second")

            expect((await header(path)).title).toBe("second")
            // One header line, still. A rewrite that appended would leave the
            // file with two, and every reader takes line 1.
            expect((await readFile(path, "utf-8")).trim().split("\n")).toHaveLength(1)
        })
    })
})
