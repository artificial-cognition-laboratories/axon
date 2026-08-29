import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Extensions } from "@arcforge/platform/build/extensions"
import type { Disposer } from "@arcforge/types"

/**
 * The extension loader — the surface a user's own code runs through.
 *
 * Every test here drives it against a REAL directory with REAL .ts files, and
 * asserts through a fake API installed on globalThis: the same seam the TUI
 * fills in with its composables. That is what makes load order, containment and
 * teardown testable without a terminal, and it is why the loader lives in
 * platform rather than in the app.
 */

/** Records what the user's files registered, in the order they did it. */
type Recorder = {
    calls: string[]
    disposed: string[]
}

/**
 * Install a minimal `commands` global that records registrations and hands
 * every disposer to the sink — exactly what the real implementation must do.
 */
function installFakeApi(recorder: Recorder, track: (d: Disposer) => void): void {
    const g = globalThis as Record<string, unknown>
    g.commands = {
        register(path: string) {
            recorder.calls.push(path)
            const dispose: Disposer = () => { recorder.disposed.push(path) }
            track(dispose)
            return dispose
        },
    }
}

type Fixture = {
    root: string
    recorder: Recorder
    extensions: ReturnType<typeof Extensions>
}

async function withProfile(fn: (ctx: Fixture) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-ext-load-"))
    try {
        const recorder: Recorder = { calls: [], disposed: [] }
        const extensions = Extensions({ root: () => root })
        installFakeApi(recorder, d => extensions.disposers.track(d))
        await fn({ root, recorder, extensions })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

/** Write a file, creating its directory. */
async function file(path: string, contents: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, contents)
}

/** A registration line, as a user would write it. */
const registers = (name: string): string => `commands.register(${JSON.stringify(name)})\n`

/** A local extension at `extensions/<name>`, with the marker config. */
async function extension(root: string, name: string, files: Record<string, string>): Promise<void> {
    const dir = join(root, "extensions", name)
    await file(join(dir, "extension.config.ts"), "export default defineExtension({})\n")
    for (const [rel, contents] of Object.entries(files)) {
        await file(join(dir, rel), contents)
    }
}

describe("extension loader", () => {
    test("loads main.ts, then plugins alphabetically", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(join(root, "main.ts"), registers("main"))
            await file(join(root, "plugins", "b.ts"), registers("plugin-b"))
            await file(join(root, "plugins", "a.ts"), registers("plugin-a"))

            await extensions.load()

            // main.ts first — it is the file a user thinks of as their config,
            // and the one that may import others.
            expect(recorder.calls).toEqual(["main", "plugin-a", "plugin-b"])
        })
    })

    test("an empty profile loads nothing and reports nothing", async () => {
        await withProfile(async ({ recorder, extensions }) => {
            const result = await extensions.load()

            expect(recorder.calls).toEqual([])
            expect(result.errors).toEqual([])
        })
    })

    test("loads extensions after the profile, in config order", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(join(root, "main.ts"), registers("profile"))
            await extension(root, "one", { "main.ts": registers("one") })
            await extension(root, "two", { "main.ts": registers("two") })
            await file(
                join(root, "profile.config.ts"),
                `export default defineProfile({ extensions: ["./extensions/two", "./extensions/one"] })\n`,
            )

            const result = await extensions.load()

            // The profile always wins (first), then declaration order — NOT
            // alphabetical. Under first-wins collisions, order is the policy.
            expect(recorder.calls).toEqual(["profile", "two", "one"])
            expect(result.errors).toEqual([])
        })
    })

    test("an extension's own plugins load with it", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await extension(root, "one", {
                "main.ts": registers("one-main"),
                "plugins/hooks.ts": registers("one-plugin"),
            })
            await file(
                join(root, "profile.config.ts"),
                `export default defineProfile({ extensions: ["./extensions/one"] })\n`,
            )

            await extensions.load()

            expect(recorder.calls).toEqual(["one-main", "one-plugin"])
        })
    })

    test("a throwing plugin disables only itself", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(join(root, "main.ts"), registers("main"))
            await file(join(root, "plugins", "a.ts"), registers("a"))
            await file(join(root, "plugins", "b.ts"), `throw new Error("boom")\n`)
            await file(join(root, "plugins", "c.ts"), registers("c"))

            const result = await extensions.load()

            // b is gone; its siblings are not. A broken config must never cost
            // a user the terminal they need in order to go fix it.
            expect(recorder.calls).toEqual(["main", "a", "c"])

            const failed = result.sources[0]!.files.filter(f => f.error !== null)
            expect(failed).toHaveLength(1)
            expect(failed[0]!.path).toContain("b.ts")
        })
    })

    test("registrations made before a file throws survive", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(
                join(root, "main.ts"),
                `${registers("before")}throw new Error("boom")\n${registers("after")}`,
            )

            await extensions.load()

            // Not rolled back: what registered is real, and removing it would
            // surprise a user whose command works until the file's last line.
            expect(recorder.calls).toEqual(["before"])
        })
    })

    test("a broken profile.config.ts still loads the profile's own files", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(join(root, "main.ts"), registers("main"))
            await file(join(root, "profile.config.ts"), `throw new Error("boom")\n`)

            const result = await extensions.load()

            // The extension LIST is unreadable; the config the user already had
            // working is not affected by that.
            expect(recorder.calls).toEqual(["main"])
            expect(result.errors).toHaveLength(1)
            expect((result.errors[0] as { code: string }).code).toBe("AX-EXT-002")
        })
    })

    test("a config that never calls defineProfile is reported", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "profile.config.ts"), `export default {}\n`)

            const result = await extensions.load()

            expect((result.errors[0] as { code: string }).code).toBe("AX-EXT-001")
        })
    })

    test("a missing extension is reported and the rest still load", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await extension(root, "real", { "main.ts": registers("real") })
            await file(
                join(root, "profile.config.ts"),
                `export default defineProfile({ extensions: ["./extensions/ghost", "./extensions/real"] })\n`,
            )

            const result = await extensions.load()

            expect(recorder.calls).toEqual(["real"])
            expect((result.errors[0] as { code: string }).code).toBe("AX-EXT-004")
        })
    })

    test("a directory without extension.config.ts is not an extension", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "extensions", "bare", "main.ts"), registers("bare"))
            await file(
                join(root, "profile.config.ts"),
                `export default defineProfile({ extensions: ["./extensions/bare"] })\n`,
            )

            const result = await extensions.load()

            expect((result.errors[0] as { code: string }).code).toBe("AX-EXT-006")
        })
    })

    test("an uninstalled registry entry reports rather than silently skipping", async () => {
        await withProfile(async ({ root, extensions }) => {
            await file(
                join(root, "profile.config.ts"),
                `export default defineProfile({ extensions: ["@axon/nope"] })\n`,
            )

            // No install thunk — a caller that only loads local extensions.
            const result = await extensions.load()

            expect((result.errors[0] as { code: string }).code).toBe("AX-EXT-004")
        })
    })

    test("enabled: false keeps the entry but does not load it", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await extension(root, "off", { "main.ts": registers("off") })
            await file(
                join(root, "profile.config.ts"),
                `export default defineProfile({
    extensions: [{ source: "./extensions/off", enabled: false }],
})\n`,
            )

            const result = await extensions.load()

            expect(recorder.calls).toEqual([])
            expect(result.errors).toEqual([])
        })
    })

    test("unload disposes everything, newest first", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(join(root, "main.ts"), registers("main"))
            await file(join(root, "plugins", "a.ts"), registers("a"))

            await extensions.load()
            extensions.unload()

            // Reverse registration order: a later registration may have been
            // made against state an earlier one owns.
            expect(recorder.disposed).toEqual(["a", "main"])
            expect(extensions.sources).toEqual([])
        })
    })

    test("reload tears down completely before re-registering", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(join(root, "main.ts"), registers("main"))

            await extensions.load()
            await extensions.reload()

            // One disposal, then one fresh registration — not two live copies.
            // This is the accumulation that makes one keystroke fire N times.
            expect(recorder.calls).toEqual(["main", "main"])
            expect(recorder.disposed).toEqual(["main"])
        })
    })

    test("reload picks up an edited file", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            await file(join(root, "main.ts"), registers("before"))
            await extensions.load()

            await file(join(root, "main.ts"), registers("after"))
            await extensions.reload()

            // Cache-busted on import — a stale module would replay "before".
            expect(recorder.calls).toEqual(["before", "after"])
        })
    })

    test("a throwing disposer does not strand the rest", async () => {
        await withProfile(async ({ root, recorder, extensions }) => {
            const g = globalThis as Record<string, unknown>
            g.commands = {
                register(path: string) {
                    recorder.calls.push(path)
                    const dispose: Disposer = () => {
                        if (path === "bad") throw new Error("boom")
                        recorder.disposed.push(path)
                    }
                    extensions.disposers.track(dispose)
                    return dispose
                },
            }

            await file(join(root, "main.ts"), `${registers("good")}${registers("bad")}`)
            await extensions.load()
            extensions.unload()

            // "good" registered first, so it disposes last — and still runs.
            expect(recorder.disposed).toEqual(["good"])
        })
    })
})

describe("a malformed extensions field", () => {
    /**
     * `extensions` must be an ARRAY, and saying so is not pedantry.
     *
     * `for...of` over a string walks its characters, so `extensions:
     * "@cody/theme"` — a plausible typo, and the shape a single-entry config
     * wants to be — became one registry entry PER LETTER. Each was resolved as
     * a package name and reported missing: eleven confusing errors for one
     * obvious mistake, with nothing naming the actual cause.
     */
    test("a string is refused, not walked character by character", async () => {
        await withProfile(async ({ root, extensions, recorder }) => {
            await file(join(root, "profile.config.ts"), `export default defineProfile({ extensions: "@cody/theme" })\n`)
            await file(join(root, "main.ts"), `commands.register("mine")\n`)

            const result = await extensions.load()

            // One error naming the real mistake, not one per character.
            expect(result.errors).toHaveLength(1)
            expect(String((result.errors[0] as { message?: unknown }).message)).toContain("must be an array")
            // The profile's own files still load — a broken extension LIST
            // must not cost the user their own config.
            expect(recorder.calls).toEqual(["mine"])
        })
    })

    test("an absent extensions field is not an error", async () => {
        // Declaring none and declaring it wrongly are different states.
        await withProfile(async ({ root, extensions }) => {
            await file(join(root, "profile.config.ts"), `export default defineProfile({})\n`)

            const result = await extensions.load()

            expect(result.errors).toEqual([])
        })
    })
})
