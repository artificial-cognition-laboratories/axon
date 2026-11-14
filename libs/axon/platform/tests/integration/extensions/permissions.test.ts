import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Extensions, readPermissions, setPermissions } from "@arcforge/platform/build/extensions"

async function withConfig(contents: string, fn: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-permissions-"))
    try {
        await writeFile(join(root, "profile.config.ts"), contents)
        await fn(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("profile permissions", () => {
    test("defaults to normal when no preset is declared", async () => {
        await withConfig(`export default defineProfile({ extensions: [] })\n`, async root => {
            expect(await readPermissions(root)).toBe("normal")
        })
    })

    test("writes beside existing profile properties and reads the exact preset", async () => {
        await withConfig(`export default defineProfile({\n    extensions: [],\n    policy: { fs: { read: ["~/work"] } },\n})\n`, async root => {
            expect(await setPermissions(root, "ask")).toEqual({ changed: true })
            expect(await readPermissions(root)).toBe("ask")

            const text = await readFile(join(root, "profile.config.ts"), "utf-8")
            expect(text).toContain(`policy: { fs: { read: ["~/work"] } },`)
            expect(text).toContain(`permissions: "ask",`)
        })
    })

    test("replaces in place and leaves a no-op byte-identical", async () => {
        await withConfig(`export default defineProfile({\n    permissions: "normal",\n})\n`, async root => {
            await setPermissions(root, "allow")
            const updated = await readFile(join(root, "profile.config.ts"), "utf-8")
            expect(updated).toContain(`permissions: "allow"`)
            expect(await setPermissions(root, "allow")).toEqual({ changed: false })
            expect(await readFile(join(root, "profile.config.ts"), "utf-8")).toBe(updated)
        })
    })

    test("rejects an invalid hand-authored preset instead of silently weakening it", async () => {
        await withConfig(`export default defineProfile({ permissions: "yolo" })\n`, async root => {
            await expect(readPermissions(root)).rejects.toMatchObject({ code: "AX-EXT-026" })
        })
    })

    test("a command write reaches the profile watcher, so the active agent reloads", async () => {
        await withConfig(`export default defineProfile({ extensions: [] })\n`, async root => {
            const extensions = Extensions({ root: () => root })
            let reloads = 0
            const stop = extensions.watch(async () => { reloads++ })
            try {
                await extensions.setPermissions("ask")
                await Bun.sleep(600)
                expect(reloads).toBe(1)
            } finally {
                stop()
            }
        })
    })
})
