import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Sessions } from "../../src/build/runtime/sessions"
import type { StoreT } from "../../src/services/store"

/**
 * `sessions.latest()` — what `axon --continue` reopens.
 *
 * The interesting behaviour is entirely in WHICH record it picks, so these
 * build real session logs on disk and let the scanner read them. A fake store
 * supplies only the two things Sessions() asks of it (the active profile and
 * where its agents live), because the alternative — booting a real profile —
 * would test the store rather than the selection rule.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A session log with a header, optionally carrying one conversation entry. */
type Spec = { agent: string; id: string; entries: boolean; modifiedAt?: number }

async function profileWith(specs: Spec[], running: string[] = []) {
    const root = await mkdtemp(join(tmpdir(), "axon-latest-"))
    roots.push(root)

    for (const spec of specs) {
        // The DEFAULT data path — the one Sessions() scans first.
        const dir = join(root, spec.agent, ".agent", "data", "sessions")
        await mkdir(dir, { recursive: true })

        const lines: unknown[] = [
            { type: "session:header", sessionId: spec.id, startedAt: new Date().toISOString() },
            { type: "axon:session:opened", data: {} },
        ]
        if (spec.entries) lines.push({ type: "cognet:stimulus:text", data: { content: "hello" } })

        const file = join(dir, `${spec.id}.jsonl`)
        await writeFile(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n")

        // mtime is what orders the list, so it is set explicitly rather than
        // left to the order the files happened to be written in.
        if (spec.modifiedAt !== undefined) {
            const seconds = spec.modifiedAt / 1000
            await utimes(file, seconds, seconds)
        }
    }

    const agents = [...new Set(specs.map(spec => spec.agent))]
    const store = {
        profiles: {
            active: () => ({
                agents: {
                    // locations(), not list(): the lister enumerates agent
                    // DIRECTORIES, so that a copy shadowed by a same-named
                    // checkout still contributes its recorded history.
                    locations: () => agents.map(name => ({ root: join(root, name), name, kind: "installed" as const })),
                },
            }),
        },
    } as unknown as StoreT

    return Sessions({ store, isRunning: id => running.includes(id) })
}

describe("sessions.latest", () => {
    test("returns the most recently modified conversation", async () => {
        const sessions = await profileWith([
            { agent: "zeno", id: "older", entries: true, modifiedAt: 1_000_000_000_000 },
            { agent: "zeno", id: "newest", entries: true, modifiedAt: 2_000_000_000_000 },
        ])

        expect(sessions.latest()?.sessionId).toBe("newest")
    })

    test("SKIPS empty sessions, even when they are newer", async () => {
        // The case that makes the filter load-bearing: a session file exists
        // from the moment an agent boots. Resuming one restores nothing, which
        // is indistinguishable from --continue having failed.
        const sessions = await profileWith([
            { agent: "zeno", id: "real-conversation", entries: true, modifiedAt: 1_000_000_000_000 },
            { agent: "zeno", id: "booted-never-used", entries: false, modifiedAt: 2_000_000_000_000 },
        ])

        expect(sessions.latest()?.sessionId).toBe("real-conversation")
    })

    test("returns null when every session is empty", async () => {
        const sessions = await profileWith([
            { agent: "zeno", id: "a", entries: false },
            { agent: "zeno", id: "b", entries: false },
        ])

        expect(sessions.latest()).toBeNull()
    })

    test("returns null when there are no sessions at all", async () => {
        const sessions = await profileWith([])
        expect(sessions.latest()).toBeNull()
    })

    test("crosses agents — the newest conversation wins whichever agent held it", async () => {
        const sessions = await profileWith([
            { agent: "zeno", id: "zeno-old", entries: true, modifiedAt: 1_000_000_000_000 },
            { agent: "barry", id: "barry-new", entries: true, modifiedAt: 2_000_000_000_000 },
        ])

        const latest = sessions.latest()
        expect(latest?.sessionId).toBe("barry-new")
        // The record carries its own agent, which is what lets the caller
        // resume without having selected an agent first.
        expect(latest?.agent).toBe("barry")
    })

    test("a running session is still a valid answer", async () => {
        // Resuming dispatches to focus() for a live session, so excluding it
        // here would skip past the conversation the user most likely means.
        const sessions = await profileWith(
            [{ agent: "zeno", id: "live", entries: true }],
            ["live"],
        )

        const latest = sessions.latest()
        expect(latest?.sessionId).toBe("live")
        expect(latest?.running).toBe(true)
    })

    test("agrees with list() — latest is its first entry with content", async () => {
        const sessions = await profileWith([
            { agent: "zeno", id: "a", entries: true, modifiedAt: 1_000_000_000_000 },
            { agent: "zeno", id: "b", entries: false, modifiedAt: 3_000_000_000_000 },
            { agent: "zeno", id: "c", entries: true, modifiedAt: 2_000_000_000_000 },
        ])

        const expected = sessions.list().find(record => record.hasEntries)
        expect(sessions.latest()).toEqual(expected!)
        expect(sessions.latest()?.sessionId).toBe("c")
    })
})
