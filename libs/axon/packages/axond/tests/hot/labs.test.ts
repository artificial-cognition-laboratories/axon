import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Labs } from "../../src/labs"
import { MinecraftLab } from "../../src/labs/minecraft"
import { TerrariaLab } from "../../src/labs/terraria"
import { TerraverseLab } from "../../src/labs/terraverse"

const roots: string[] = []
/** These tests boot no agent; a launch reaching here is a bug in the test. */
const launcher = {
    zeno: async (): Promise<string> => { throw new Error("this test boots no agent") },
    launch: async (): Promise<never> => { throw new Error("this test boots no agent") },
}

async function lab() {
    const root = await mkdtemp(join(tmpdir(), "axond-labs-"))
    roots.push(root)
    return Labs({ root: root, launcher: launcher, build: "development" })
}

describe("labs", () => {
    test("registers Terraverse alone, without probing for terra", async () => {
        const labs = await lab()

        expect(Object.keys(labs.all)).toEqual(["terraverse"])
    })

    test("says when terra is missing, and lists no worlds it can't ask for", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-terraverse-"))
        roots.push(root)
        const terraverse = TerraverseLab({ root: root, build: "development", terra: join(root, "missing-terra") })

        const state = await terraverse.state()
        expect(state.id).toBe("terraverse")
        expect(state.worlds).toEqual([])
        expect(state.problem).toContain("no terra at")
    })

    test("lists the player's worlds as terra says them", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-terraverse-worlds-"))
        roots.push(root)
        const world = join(root, "Kilns")
        await mkdir(world, { recursive: true })
        await writeFile(join(world, "world.mt"), "world_name = Kilns\n")
        // a terra that answers `worlds --json` as the real one does
        const terra = join(root, "terra")
        await writeFile(terra, `#!/bin/sh\necho '${JSON.stringify({ profile: "local", worlds: [{ name: "Kilns", title: "Kilns", path: world, server: null }] })}'\n`, { mode: 0o755 })
        const terraverse = TerraverseLab({ root: root, build: "development", terra: terra })

        const state = await terraverse.state()
        expect(state.problem).toBeNull()
        expect(state.worlds.map(w => [w.name, w.path])).toEqual([["Kilns", world]])
    })

    test("reports a missing Terraria install when the lab is read, not constructed", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-labs-missing-"))
        roots.push(root)
        const terraria = TerrariaLab({
            root: root,
            installDir: join(root, "missing-install"),
            userDir: join(root, "missing-user"),
        })

        const state = await terraria.state()
        expect(state.problem).toContain("tModLoader is not installed")
    })

    test("reports a missing Minecraft server when the lab is read, not constructed", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-minecraft-missing-"))
        roots.push(root)
        const minecraft = MinecraftLab({ root: root, launcher: launcher, java: join(root, "missing-java"), modSource: join(root, "missing-mod") })

        const state = await minecraft.state()
        expect(state.id).toBe("minecraft")
        expect(state.problem).toContain("no AxonM Gradle project")
    })

    /**
     * The install check used to be the launcher jar's EXISTENCE, whose name is
     * the same for every Minecraft. So after a retarget it answered "installed"
     * while the caller was asking "is THIS version installed", and a 26.3
     * server was started for a 1.21.11 client — a protocol mismatch at join
     * time, nowhere near its cause.
     */
    test("refuses a server installed for a different Minecraft than the lab runs", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-minecraft-stale-"))
        roots.push(root)
        await writeFile(join(root, "fabric-server-launch.jar"), "")
        await writeFile(join(root, "axon-server.json"), JSON.stringify({ minecraft: "26.3", loader: "0.19.5" }))
        await writeFile(join(root, "eula.txt"), "eula=true\n")
        await mkdir(join(root, "AxonM"), { recursive: true })
        await writeFile(join(root, "AxonM", "gradlew"), "")

        const state = await MinecraftLab({ root: root, launcher: launcher, java: "sh" }).state()

        expect(state.problem).toContain("is Minecraft 26.3")
        expect(state.problem).toContain("this lab runs 1.21.11")
    })

    /** A launcher jar with no stamp predates the record: its version is unknown, so it is not trusted. */
    test("treats an unstamped server install as not installed rather than guessing", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-minecraft-unstamped-"))
        roots.push(root)
        await writeFile(join(root, "fabric-server-launch.jar"), "")
        await mkdir(join(root, "AxonM"), { recursive: true })
        await writeFile(join(root, "AxonM", "gradlew"), "")

        const state = await MinecraftLab({ root: root, launcher: launcher, java: "sh" }).state()

        expect(state.problem).toContain("is not installed")
    })
})

afterAll(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})
