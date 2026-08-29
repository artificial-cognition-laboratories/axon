import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fsx } from "@arcforge/platform/utils/fs"

/**
 * Absence is data; unreadable is a fault.
 *
 * Every scanner in this package reads a null from fsx as "that surface doesn't
 * exist" and carries on — a project with no README, an agent with no .env, a
 * module with no package.json. That is correct and load-bearing.
 *
 * What is NOT correct is answering the same way for a file that exists and
 * could not be read. These used to be indistinguishable: an axon.config.ts with
 * wrong permissions reported as a MISSING config, and the user was told to
 * create a file that was already there.
 */

const roots: string[] = []
afterEach(async () => {
    // Restore permissions before removal — a 000 file in a 000 directory
    // cannot be unlinked, and the sweep would silently leak temp dirs.
    for (const root of roots.splice(0)) {
        await chmod(root, 0o755).catch(() => {})
        await rm(root, { recursive: true, force: true })
    }
})

async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-fsx-"))
    roots.push(root)
    return root
}

describe("fsx.readText", () => {
    test("returns the contents of a file that exists", async () => {
        const root = await scratch()
        await writeFile(join(root, "present.txt"), "hello\n")

        expect(await fsx.readText(join(root, "present.txt"))).toBe("hello\n")
    })

    test("returns null for a file that is not there — absence is an ordinary state", async () => {
        const root = await scratch()

        expect(await fsx.readText(join(root, "absent.txt"))).toBeNull()
    })

    test("throws for a file that exists but cannot be read", async () => {
        const root = await scratch()
        const path = join(root, "locked.txt")
        await writeFile(path, "secret\n")
        await chmod(path, 0o000)

        await expect(fsx.readText(path)).rejects.toMatchObject({ code: "AX-PROJECT-032" })

        await chmod(path, 0o644)
    })

    test("carries the path and the OS code so the real fault is diagnosable", async () => {
        const root = await scratch()
        const path = join(root, "locked.txt")
        await writeFile(path, "secret\n")
        await chmod(path, 0o000)

        await expect(fsx.readText(path)).rejects.toMatchObject({
            context: { path: path, code: "EACCES" },
        })

        await chmod(path, 0o644)
    })

    test("throws for a directory where a file was expected", async () => {
        const root = await scratch()
        await mkdir(join(root, "adirectory"))

        // Reported as unreadable, not as absent: something IS there, it just
        // isn't a file. Answering null would send a caller off to create it.
        await expect(fsx.readText(join(root, "adirectory"))).rejects.toMatchObject({
            code: "AX-PROJECT-032",
        })
    })
})

describe("fsx.readJson", () => {
    test("parses a file that exists", async () => {
        const root = await scratch()
        await writeFile(join(root, "package.json"), JSON.stringify({ name: "@me/thing" }))

        expect(await fsx.readJson(join(root, "package.json"))).toEqual({ name: "@me/thing" })
    })

    test("returns null for a file that is not there", async () => {
        const root = await scratch()

        expect(await fsx.readJson(join(root, "absent.json"))).toBeNull()
    })

    test("throws CORRUPT_JSON for a file that exists but does not parse", async () => {
        const root = await scratch()
        await writeFile(join(root, "broken.json"), "{ not json at all")

        await expect(fsx.readJson(join(root, "broken.json"))).rejects.toMatchObject({
            code: "AX-PROJECT-016",
        })
    })

    test("throws FILE_UNREADABLE for a file it cannot open — distinct from corrupt", async () => {
        const root = await scratch()
        const path = join(root, "locked.json")
        await writeFile(path, JSON.stringify({ ok: true }))
        await chmod(path, 0o000)

        // Both are faults, but they have different fixes: chmod versus repair
        // the contents. Collapsing them to one code loses that.
        await expect(fsx.readJson(path)).rejects.toMatchObject({ code: "AX-PROJECT-032" })

        await chmod(path, 0o644)
    })
})
