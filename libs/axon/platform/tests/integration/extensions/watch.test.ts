import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Extensions } from "@arcforge/platform/build/extensions"

/**
 * `extensions.watch()` — reload on save.
 *
 * The property under test is not "a callback fires": it is that each SAVE
 * produces exactly one reload, that the reload's own writes produce none, and
 * that this keeps holding on the second save. All three failures are invisible
 * in a passing manual test — a duplicated notice, a terminal that reloads
 * forever, a terminal that silently stops reloading after the first edit — so
 * each is asserted by counting rather than by observing that something
 * happened.
 *
 * These drive the real fs watcher against a real directory. Every wait is
 * generous relative to the 150ms debounce, because inotify delivery is
 * scheduled by the kernel and a tight bound would make this flaky rather than
 * strict.
 */

type Fixture = {
    root: string
    extensions: ReturnType<typeof Extensions>
}

async function withProfile(fn: (ctx: Fixture) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-ext-watch-"))
    try {
        // No API installed: these tests never evaluate a user file that
        // registers anything. What is being observed is the watcher, and a
        // config that registers would only add a global to reset between tests.
        await fn({ root, extensions: Extensions({ root: () => root }) })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

async function file(path: string, contents: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, contents)
}

/** Long enough for the debounce to elapse and the callback to run. */
const SETTLE = 600

describe("extensions.watch", () => {
    test("a save triggers exactly one reload", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "main.ts"), "// v1\n")

            let reloads = 0
            const stop = extensions.watch(async () => { reloads++ })
            try {
                await file(join(root, "main.ts"), "// v2\n")
                await Bun.sleep(SETTLE)

                expect(reloads).toBe(1)
            } finally {
                stop()
            }
        })
    })

    test("a burst of writes collapses into one reload", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "main.ts"), "// v1\n")

            let reloads = 0
            const stop = extensions.watch(async () => { reloads++ })
            try {
                // What an editor save actually looks like: several writes in
                // quick succession. One user action must mean one reload.
                for (let i = 0; i < 5; i++) {
                    await file(join(root, "main.ts"), `// v${i}\n`)
                    await Bun.sleep(10)
                }
                await Bun.sleep(SETTLE)

                expect(reloads).toBe(1)
            } finally {
                stop()
            }
        })
    })

    test("writes made BY the reload do not retrigger it", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "main.ts"), "// v1\n")

            let reloads = 0
            const stop = extensions.watch(async () => {
                reloads++
                // Stands in for what a real reload writes into the profile —
                // an install's lockfile, a regenerated frame. Without the
                // suspension this is an infinite loop, and the assertion below
                // is what would catch it.
                await file(join(root, "generated.ts"), `// ${reloads}\n`)
            })
            try {
                await file(join(root, "main.ts"), "// v2\n")
                await Bun.sleep(SETTLE * 2)

                expect(reloads).toBe(1)
            } finally {
                stop()
            }
        })
    })

    test("a second save after the first reload triggers a second reload", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "main.ts"), "// v1\n")

            // The guarantee is per-save, not merely once-ever: a user editing
            // repeatedly must keep getting reloads. The deaf window that stops
            // the reload's own writes from retriggering it is the obvious way
            // to break this — a gate that failed to reopen would leave the
            // terminal permanently stale after one save, with nothing to say
            // so, so it is asserted rather than assumed.
            let reloads = 0
            const stop = extensions.watch(async () => { reloads++ })
            try {
                await file(join(root, "main.ts"), "// v2\n")
                await Bun.sleep(SETTLE)
                expect(reloads).toBe(1)

                await file(join(root, "main.ts"), "// v3\n")
                await Bun.sleep(SETTLE)
                expect(reloads).toBe(2)
            } finally {
                stop()
            }
        })
    })

    test("generated output is ignored", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "main.ts"), "// v1\n")

            let reloads = 0
            const stop = extensions.watch(async () => { reloads++ })
            try {
                // The frame is written by prepare() on every boot, store/ holds
                // session history that Axon appends to continuously, and
                // agents/ is watched by each agent itself. A change in any of
                // them is not a change to the terminal's configuration.
                await file(join(root, ".axon", "types", "globals.d.ts"), "// x\n")
                await file(join(root, "store", "history.jsonl"), "{}\n")
                await file(join(root, "agents", "zeno", "main.ts"), "// x\n")
                await Bun.sleep(SETTLE)

                expect(reloads).toBe(0)
            } finally {
                stop()
            }
        })
    })

    test("an install or uninstall made by the CLI triggers a reload", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "profile.config.ts"), "export default defineProfile({ extensions: [] })\n")

            let reloads = 0
            const stop = extensions.watch(async () => { reloads++ })
            try {
                // `axon install` runs in a DIFFERENT process and writes two
                // things: the fetched directory, and the config entry. A running
                // terminal has to notice, or the CLI would have to tell users to
                // restart — an instruction for something the system already does.
                await file(join(root, "extensions", "vim", "extension.config.ts"), "export default defineExtension({})\n")
                await file(join(root, "profile.config.ts"), 'export default defineProfile({ extensions: ["@axon/vim"] })\n')
                await Bun.sleep(SETTLE)
                expect(reloads).toBe(1)

                // And the reverse — uninstall deletes the directory and rewrites
                // the config.
                await rm(join(root, "extensions", "vim"), { recursive: true, force: true })
                await file(join(root, "profile.config.ts"), "export default defineProfile({ extensions: [] })\n")
                await Bun.sleep(SETTLE)
                expect(reloads).toBe(2)
            } finally {
                stop()
            }
        })
    })

    test("stop() ends it", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "main.ts"), "// v1\n")

            let reloads = 0
            const stop = extensions.watch(async () => { reloads++ })
            stop()

            await file(join(root, "main.ts"), "// v2\n")
            await Bun.sleep(SETTLE)

            expect(reloads).toBe(0)
        })
    })
})
