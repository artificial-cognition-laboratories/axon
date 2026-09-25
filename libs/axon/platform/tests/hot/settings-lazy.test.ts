import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "../../src/platform"

/**
 * `paths` is real from the FIRST read, with nobody having primed anything.
 *
 * This is the behavioural half of settings-priming.test.ts. That file pins
 * what a primed vs unprimed cache does; this pins that no caller has to know
 * the difference — because relying on someone remembering to prime is what
 * broke three separate times.
 *
 * The first two (CLI, then TUI) were fixed by adding a `refreshSettings()`
 * call at each entry point, and guarded by grepping the source for that call.
 * A grep cannot see WHICH reads the priming gates, so the third slipped
 * straight past it: the TUI's priming gates the agent boot, and the `^`
 * session palette reads sessions on a path that never waits for it. Result —
 * "no past sessions" for an agent with 563 on disk, silently, because an
 * empty list is exactly what a genuinely new agent looks like.
 *
 * The fix is structural: the cache fills itself on first read. So this asserts
 * the property directly — construct Platform, read, get the truth — which is
 * the one thing a caller cannot get wrong by forgetting.
 */

const PROFILE = "test@axon.dev"

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-lazy-settings-"))
    const watched = join(root, "checkout")

    // A watched agent, with one session on disk.
    const agentRoot = join(watched, "barry")
    await mkdir(join(agentRoot, ".agent", "data", "sessions"), { recursive: true })
    await writeFile(join(agentRoot, "axon.config.ts"), "export default defineAgent({})\n")
    await writeFile(join(agentRoot, "package.json"), JSON.stringify({ name: "@cody/barry" }))
    await writeFile(
        join(agentRoot, ".agent", "data", "sessions", "abc.jsonl"),
        [
            JSON.stringify({ type: "session:header", version: 2, agentId: "@cody/barry", sessionId: "abc", startedAt: "2026-01-01T00:00:00.000Z" }),
            JSON.stringify({ type: "axon:message", time: { ms: 1, seq: 0 }, data: {} }),
        ].join("\n") + "\n",
    )

    // A profile that declares the checkout as a watched path.
    const profileRoot = join(root, "profiles", PROFILE)
    await mkdir(join(profileRoot, "agents"), { recursive: true })
    await writeFile(
        join(profileRoot, "profile.config.ts"),
        `export default defineProfile({\n    settings: {\n        paths: [${JSON.stringify(watched)}],\n    },\n})\n`,
    )

    return { root, watched, agentRoot, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function platformFor(root: string) {
    const platform = Platform({ version: "0.0.0", store: root } as never)
    platform.store.profiles.save(PROFILE, { user: { email: PROFILE } } as never)
    return platform
}

describe("declared paths are live on first read", () => {
    it("extraRoots resolves without any refreshSettings() call", async () => {
        const f = await fixture()
        const platform = platformFor(f.root)

        // No priming. This is the first thing anything asks.
        expect(platform.store.profiles.active()!.agents.extraRoots()).toEqual([f.watched])

        await f.cleanup()
    })

    it("an agent in a watched root is findable without priming", async () => {
        const f = await fixture()
        const platform = platformFor(f.root)

        const found = platform.store.profiles.active()!.agents.find("@cody/barry")
        expect(found).toHaveLength(1)
        expect(found[0]!.root).toBe(f.agentRoot)

        await f.cleanup()
    })

    it("a watched agent's sessions are listed without priming", async () => {
        // The `^` palette's read. It never waited for the TUI's priming and
        // had no reason to — which is precisely why the answer must not
        // depend on whether anyone did.
        const f = await fixture()
        const platform = platformFor(f.root)

        const sessions = platform.agents.sessions()
        expect(sessions.map(record => record.sessionId)).toContain("abc")

        await f.cleanup()
    })

    it("a config written AFTER construction is still picked up", async () => {
        // Construction is wiring — it must not snapshot the config. A profile
        // that logs in later, or a config saved mid-session, has to be read
        // when it is asked for rather than assumed absent forever.
        const f = await fixture()
        const platform = platformFor(f.root)

        const later = join(f.root, "later")
        await mkdir(later, { recursive: true })
        await writeFile(
            join(f.root, "profiles", PROFILE, "profile.config.ts"),
            `export default defineProfile({\n    settings: {\n        paths: [${JSON.stringify(later)}],\n    },\n})\n`,
        )
        await platform.refreshSettings()

        expect(platform.store.profiles.active()!.agents.extraRoots()).toEqual([later])

        await f.cleanup()
    })
})
