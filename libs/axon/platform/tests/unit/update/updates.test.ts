import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store } from "@arcforge/platform/store"
import { Updates, packagedHelperPath } from "@arcforge/platform/update"

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(latest: string) {
    const root = await mkdtemp(join(tmpdir(), "axon-update-"))
    roots.push(root)
    const helperPath = join(root, "update-helper.js")
    await writeFile(helperPath, "// fixture")
    const requestPath = join(root, "request.json")
    const releaseRequests: Array<{ fresh?: boolean }> = []
    const updates = Updates({
        currentVersion: "2.0.20",
        helperPath,
        bunPath: "/bun",
        axonPath: "/axon",
        requestPath,
        store: Store({ root }),
        cloud: {
            cloud: {
                releases: {
                    axon: async (_signal, options = {}) => {
                        releaseRequests.push(options)
                        return { package: "@arcforge/axon", channel: "latest", version: latest }
                    },
                },
            },
        } as never,
    })
    return { updates, requestPath, releaseRequests, root }
}

describe("Platform updates", () => {
    test("finds the packaged helper when Axon is invoked through a global-bin symlink", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-update-symlink-"))
        roots.push(root)
        const packageDir = join(root, "package")
        const binDir = join(root, "bin")
        await Promise.all([mkdir(packageDir), mkdir(binDir)])
        const entryPath = join(packageDir, "index.js")
        await Promise.all([
            writeFile(entryPath, "// fixture"),
            writeFile(join(packageDir, "update-helper.js"), "// fixture"),
        ])
        const shimPath = join(binDir, "axon")
        await symlink(entryPath, shimPath)

        expect(packagedHelperPath(shimPath)).toBe(join(packageDir, "update-helper.js"))
    })

    test("reports whether the exact backend release is newer", async () => {
        const { updates } = await fixture("2.0.21")
        expect(await updates.check()).toEqual({
            status: "available",
            current: "2.0.20",
            latest: "2.0.21",
        })
    })

    test("writes an exact update request for the supervisor", async () => {
        const { updates, requestPath, releaseRequests, root } = await fixture("2.0.21")
        expect((await updates.handoff()).status).toBe("available")
        expect(releaseRequests).toEqual([{ fresh: true }])
        expect(JSON.parse(await readFile(requestPath, "utf-8"))).toEqual({
            from: "2.0.20",
            to: "2.0.21",
            bun: "/bun",
            axon: "/axon",
            state: join(root, "update.json"),
        })
        expect(Store({ root }).update.state.get()).toMatchObject({
            status: "pending",
            from: "2.0.20",
            to: "2.0.21",
        })
    })

    test("does not request an update when already current", async () => {
        const { updates, requestPath } = await fixture("2.0.20")
        expect((await updates.handoff()).status).toBe("current")
        expect(await Bun.file(requestPath).exists()).toBe(false)
    })
})
