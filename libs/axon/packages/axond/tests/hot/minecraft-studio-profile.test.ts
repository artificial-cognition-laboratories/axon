import { afterAll, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Profile } from "../../src/labs/minecraft/studio/profile"

const root = await mkdtemp(join(tmpdir(), "axon-studio-profile-"))
afterAll(() => rm(root, { recursive: true, force: true }))

const mods = { install: async (dir: string) => { await writeFile(join(dir, "worldedit-mod-7.4.2.jar"), "pinned") } }

async function fixture(name: string) {
    const template = join(root, name, "template")
    await mkdir(join(template, "saves", "Personal"), { recursive: true })
    await writeFile(join(template, "options.txt"), "fov:0.5\nmaxFps:60\n")
    await writeFile(join(root, name, "AxonM.jar"), "axonm")
    return Profile({ dir: join(root, name, "studio"), template: template, stagedMod: join(root, name, "AxonM.jar"), worlds: join(root, name, "worlds"), mods: mods })
}

test("the authoring client's Singleplayer worlds are the lab's, with AxonM and the building mods installed", async () => {
    const profile = await fixture("fresh")
    await profile.prepare({ maxFps: "120" })
    const saves = join(profile.gameDir, "saves")
    expect((await lstat(saves)).isSymbolicLink()).toBe(true)
    expect(await readlink(saves)).toBe(join(root, "fresh", "worlds"))
    expect(await readFile(join(profile.gameDir, "mods", "AxonM.jar"), "utf-8")).toBe("axonm")
    expect(await readFile(join(profile.gameDir, "mods", "worldedit-mod-7.4.2.jar"), "utf-8")).toBe("pinned")
    expect(await readFile(join(profile.gameDir, "options.txt"), "utf-8")).toBe("fov:0.5\nmaxFps:120\n")
    // Preparing again is the same profile, not a new one.
    await profile.prepare({ maxFps: "60" })
    expect(await readlink(saves)).toBe(join(root, "fresh", "worlds"))
})

test("a saves folder already holding worlds is refused by name, never deleted", async () => {
    const profile = await fixture("held")
    await mkdir(join(profile.gameDir, "saves", "Mine"), { recursive: true })
    expect(profile.prepare({})).rejects.toThrow("holds Mine")
    expect((await lstat(join(profile.gameDir, "saves", "Mine"))).isDirectory()).toBe(true)
})
