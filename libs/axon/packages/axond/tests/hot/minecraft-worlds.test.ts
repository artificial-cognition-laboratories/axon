import { afterAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worlds } from "../../src/labs/minecraft/worlds"

const root = await mkdtemp(join(tmpdir(), "axon-minecraft-worlds-"))
afterAll(() => rm(root, { recursive: true, force: true }))

test("discovers personal saves, imports a copy, and archives only the managed world", async () => {
    const saves = join(root, "saves")
    const personal = join(saves, "Puzzle")
    await mkdir(personal, { recursive: true })
    await writeFile(join(personal, "level.dat"), "original")
    const worlds = Worlds({ root: root, managed: join(root, "worlds"), prismGame: join(root, "prism"), minecraftSaves: saves })
    expect((await worlds.list()).find(world => world.name === "Puzzle")?.source).toBe("minecraft")

    await worlds.import({ name: "Puzzle", source: "minecraft" })
    expect((await worlds.list()).find(world => world.name === "Puzzle")?.source).toBe("lab")
    await writeFile(join(personal, "level.dat"), "personal changed")
    expect(await readFile(join(root, "worlds", "Puzzle", "level.dat"), "utf-8")).toBe("original")
    expect(worlds.import({ name: "Puzzle", source: "minecraft" })).rejects.toThrow("already exists")

    const archived = await worlds.remove({ name: "Puzzle" })
    expect(await readFile(join(archived, "level.dat"), "utf-8")).toBe("original")
    expect(await readFile(join(personal, "level.dat"), "utf-8")).toBe("personal changed")
    expect((await worlds.list()).find(world => world.name === "Puzzle")?.source).toBe("minecraft")
})

test("a world made in the game is listed as the lab's, and names cannot escape the managed directory", async () => {
    const worlds = Worlds({ root: root, managed: join(root, "worlds"), prismGame: join(root, "prism"), minecraftSaves: join(root, "saves") })
    await mkdir(join(root, "worlds", "New Arena"), { recursive: true })
    expect((await worlds.list()).find(world => world.name === "New Arena")?.source).toBe("lab")
    expect(worlds.remove({ name: "../escape" })).rejects.toThrow("Invalid Minecraft world name")
    expect(await worlds.difficulty("New Arena")).toBe("peaceful")
    await worlds.setDifficulty({ name: "New Arena", difficulty: "hard" })
    expect(await worlds.difficulty("New Arena")).toBe("hard")
})
