import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Sessions } from "../../src/build/runtime/sessions/sessions"

/**
 * A session record names its agent by IDENTITY — package.json's name.
 *
 * This is the behavioural half of `apps/tui/tests/unit/palette/session-identity.test.ts`.
 * That one pins what the `^` palette compares; this pins what the record
 * actually holds, so the two cannot drift into disagreeing again.
 *
 * They did drift, silently. `record.agent` used to be the DIRECTORY name and
 * became `identity(root)` — the manifest name — with no test on either side
 * asserting which. Every consumer comparing against a folder name kept
 * compiling and matched nothing, and only for SCOPED agents: an agent with no
 * readable manifest falls back to its directory, so those kept working and the
 * breakage looked intermittent.
 *
 * Hence the fallback case below is asserted too. It is the reason the bug hid.
 */

async function agentAt(root: string, dir: string, manifestName: string | null) {
    const agentRoot = join(root, dir)
    await mkdir(join(agentRoot, ".agent", "data", "sessions"), { recursive: true })
    if (manifestName) {
        await writeFile(join(agentRoot, "package.json"), JSON.stringify({ name: manifestName }))
    }
    await writeFile(
        join(agentRoot, ".agent", "data", "sessions", `${dir}-session.jsonl`),
        [
            JSON.stringify({ type: "session:header", version: 2, agentId: manifestName, sessionId: `${dir}-session`, startedAt: "2026-01-01T00:00:00.000Z" }),
            JSON.stringify({ type: "axon:message", time: { ms: 1, seq: 0 }, data: {} }),
        ].join("\n") + "\n",
    )
    return agentRoot
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-session-identity-"))
    // A scoped agent whose folder name and manifest name DIFFER — the case
    // that broke. The folder is "barry.mk3"; the identity is "@cody/barry.mk3".
    await agentAt(root, "barry.mk3", "@cody/barry.mk3")
    // No manifest: identity falls back to the folder. The case that kept
    // working and disguised the bug.
    await agentAt(root, "repo-state", null)

    const locations = () => [
        { root: join(root, "barry.mk3"), name: "@cody/barry.mk3", kind: "watched" as const },
        { root: join(root, "repo-state"), name: "repo-state", kind: "watched" as const },
    ]
    const store = { profiles: { active: () => ({ agents: { locations } }) } } as never
    const sessions = Sessions({ store, isRunning: () => false } as never)
    return { root, sessions, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("session records name their agent by identity", () => {
    it("uses the manifest name, not the directory name", async () => {
        const f = await fixture()

        const record = f.sessions.list().find(entry => entry.sessionId === "barry.mk3-session")
        expect(record).toBeDefined()
        expect(record!.agent).toBe("@cody/barry.mk3")
        // The exact value a consumer would have compared against and missed.
        expect(record!.agent).not.toBe("barry.mk3")

        await f.cleanup()
    })

    it("falls back to the directory name when there is no manifest", async () => {
        // Pinned because this is why the breakage looked intermittent rather
        // than total — half the agents on a machine kept matching.
        const f = await fixture()

        const record = f.sessions.list().find(entry => entry.sessionId === "repo-state-session")
        expect(record).toBeDefined()
        expect(record!.agent).toBe("repo-state")

        await f.cleanup()
    })
})
