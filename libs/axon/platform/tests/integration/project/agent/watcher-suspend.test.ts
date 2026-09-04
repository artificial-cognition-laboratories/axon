import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import type { ProjectT } from "@arcforge/platform/build/project"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect, beforeAll, afterAll } from "bun:test"

/**
 * watcher.during() — the fix for reloads landing mid-install.
 *
 * An install rewrites package.json, bunfig.toml and axon.config.ts, then
 * rebuilds node_modules. All three manifests are watched, so the watcher used
 * to fire a reload ~100ms in — while `bun install` still had the tree torn
 * down. The rescan then read a genuinely absent @arcforge/cognet and reported
 * a compile failure for an install that went on to succeed.
 *
 * These pin the two halves that make suspension correct rather than merely
 * quiet: changes the caller causes are not announced, and changes it does NOT
 * cause are still delivered.
 */
let storeDir: string
let dir: string
let project: ProjectT

// Real fs events plus the watcher's own 100ms debounce.
const SETTLE_MS = 300

beforeAll(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

    const name = `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
    project = await Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir }).projects.create("agent", { name, dir })
    await project.watcher.start()
})

afterAll(async () => {
    project.watcher.stop()
    await rm(storeDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
})

/** Collect change notifications for the duration of one test. */
function collect(): { seen: string[]; stop: () => void } {
    const seen: string[] = []
    const stop = project.watcher.onChange(path => seen.push(path))
    return { seen, stop }
}

describe("agent project: watcher suspension", () => {
    it("notifies nothing WHILE suspended, however long the work takes", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                await writeFile(join(project.root, "package.json.test"), "{}\n")
                // Well past the 100ms debounce: the whole point is that a
                // suspension outlasting it (a `bun install` is seconds) still
                // fires nothing mid-way, which is when the tree is torn down.
                await Bun.sleep(SETTLE_MS)
                expect(seen).toEqual([])
            })
        } finally {
            stop()
        }
    })

    it("collapses a burst of its own writes into one notification on resume", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                // What an install actually does: three manifests, then the
                // tree. Left to the watcher this was a reload per debounce
                // window; held, it is one.
                await writeFile(join(project.root, "package.json.test"), "{}\n")
                await writeFile(join(project.root, "bunfig.toml.test"), "x\n")
                await writeFile(join(project.root, "axon.config.ts.test"), "y\n")
                await Bun.sleep(SETTLE_MS)
            })
            await Bun.sleep(SETTLE_MS)

            expect(seen.length).toBe(1)
        } finally {
            stop()
        }
    })

    it("still notifies for writes that land after during() returns", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                await writeFile(join(project.root, "inside.txt"), "a\n")
                await Bun.sleep(SETTLE_MS)
            })
            seen.length = 0

            await writeFile(join(project.root, "after.txt"), "b\n")
            await Bun.sleep(SETTLE_MS)

            expect(seen.length).toBeGreaterThan(0)
        } finally {
            stop()
        }
    })

    it("delivers a change that arrived DURING the suspension once it ends", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                // Stands in for a user editing a file while an install runs —
                // a real change with no other chance to be noticed. Dropping it
                // would leave the agent stale until they touched something else.
                await writeFile(join(project.root, "edited-during.txt"), "user edit\n")
                await Bun.sleep(SETTLE_MS)
                expect(seen).toEqual([])
            })
            await Bun.sleep(SETTLE_MS)

            expect(seen.length).toBeGreaterThan(0)
        } finally {
            stop()
        }
    })

    /**
     * `selfReloads` — for a caller that reloads on its own when during() returns.
     *
     * Suspension alone only DEFERS: the held change is delivered on resume, so
     * an install's own reload and the watcher's fired back to back and every
     * install rescanned the whole project twice. This is the half that makes
     * "the caller reloads once" actually true.
     */
    it("delivers nothing on resume when the caller reloads itself", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                await writeFile(join(project.root, "self-reload.txt"), "e\n")
                await Bun.sleep(SETTLE_MS)
            }, { selfReloads: true })
            await Bun.sleep(SETTLE_MS)

            expect(seen).toEqual([])
        } finally {
            stop()
        }
    })

    it("keeps watching normally after a selfReloads suspension", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                await writeFile(join(project.root, "self-reload-2.txt"), "f\n")
                await Bun.sleep(SETTLE_MS)
            }, { selfReloads: true })
            await Bun.sleep(SETTLE_MS)
            seen.length = 0

            // Suppression is scoped to the one suspension — a later change is
            // an ordinary event again. Getting this wrong would leave the
            // watcher permanently deaf after the first install.
            await writeFile(join(project.root, "after-self-reload.txt"), "g\n")
            await Bun.sleep(SETTLE_MS)

            expect(seen.length).toBeGreaterThan(0)
        } finally {
            stop()
        }
    })

    /**
     * An INNER selfReloads must not silence an OUTER suspension that did not
     * ask for it.
     *
     * The inner caller's reload covers its own writes — not whatever the outer
     * span goes on to do afterwards. Discarding on the inner resume would drop
     * a change the outer caller is still relying on being told about, which is
     * the silent-staleness failure this flag is otherwise careful to avoid.
     */
    it("an inner selfReloads does not discard the outer suspension's change", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                // Stands in for a user's edit landing early in a long outer
                // span — held by the outer suspension, with nothing else to
                // announce it. It must survive the inner span entirely.
                await writeFile(join(project.root, "outer.txt"), "i\n")
                await Bun.sleep(SETTLE_MS)

                // The inner caller reloads for its own writes. Discarding on
                // ITS resume would take the outer change with it, which the
                // outer caller never agreed to.
                await project.watcher.during(async () => {
                    await writeFile(join(project.root, "inner.txt"), "h\n")
                    await Bun.sleep(SETTLE_MS)
                }, { selfReloads: true })
            })
            await Bun.sleep(SETTLE_MS)

            expect(seen.length).toBeGreaterThan(0)
        } finally {
            stop()
        }
    })

    it("restores watching when the suspended work throws", async () => {
        const { seen, stop } = collect()

        try {
            await expect(
                project.watcher.during(async () => { throw new Error("install failed") }),
            ).rejects.toThrow("install failed")

            await writeFile(join(project.root, "after-throw.txt"), "c\n")
            await Bun.sleep(SETTLE_MS)

            // A failed install must not leave the watcher deaf for the rest of
            // the session.
            expect(seen.length).toBeGreaterThan(0)
        } finally {
            stop()
        }
    })

    it("nested suspensions only resume with the outermost", async () => {
        const { seen, stop } = collect()

        try {
            await project.watcher.during(async () => {
                await project.watcher.during(async () => {
                    await writeFile(join(project.root, "nested.txt"), "d\n")
                    await Bun.sleep(SETTLE_MS)
                })
                // The inner during() returned, but the outer one is still
                // active — an inner resume here would reopen the very window
                // the outer suspension exists to hold closed.
                await Bun.sleep(SETTLE_MS)
                expect(seen).toEqual([])
            })
            await Bun.sleep(SETTLE_MS)

            expect(seen.length).toBeGreaterThan(0)
        } finally {
            stop()
        }
    })
})
