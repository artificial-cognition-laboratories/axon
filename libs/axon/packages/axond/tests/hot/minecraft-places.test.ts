import { afterAll, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Places } from "../../src/labs/minecraft/places"
import { Worlds } from "../../src/labs/minecraft/worlds"

const root = await mkdtemp(join(tmpdir(), "axon-minecraft-places-"))
afterAll(() => rm(root, { recursive: true, force: true }))

test("places belong to a managed world, persist across handles, and archive with it", async () => {
    const worlds = Worlds({ root: root, managed: join(root, "worlds"), prismGame: join(root, "prism"), minecraftSaves: join(root, "saves") })
    await mkdir(join(root, "worlds", "Arena"), { recursive: true })
    const places = Places({ directory: name => worlds.path({ name: name }) })
    const spawn = await places.add({ world: "Arena", name: "Spawn", x: 12.5, y: 70, z: -4 })
    expect((await places.list({ world: "Arena" })).map(place => place.name)).toEqual(["Spawn"])
    expect((await Places({ directory: name => worlds.path({ name: name }) }).list({ world: "Arena" }))[0]?.id).toBe(spawn.id)
    expect(places.add({ world: "Arena", name: "Outside", x: Infinity, y: 70, z: 0 })).rejects.toThrow("outside Minecraft")
    expect(places.add({ world: "Not managed", name: "No", x: 0, y: 70, z: 0 })).rejects.toThrow()
    await places.remove({ world: "Arena", id: spawn.id })
    expect(await places.list({ world: "Arena" })).toEqual([])
    expect(places.remove({ world: "Arena", id: spawn.id })).rejects.toThrow("not in Arena")
    const archivedPlace = await places.add({ world: "Arena", name: "Exit", x: 3, y: 71, z: 9 })
    const archive = await worlds.remove({ name: "Arena" })
    expect(await Bun.file(join(archive, ".axon-places.jsonl")).text()).toContain(archivedPlace.id)
})

test("corrupt place history fails visibly instead of dropping an authoring marker", async () => {
    const worlds = Worlds({ root: root, managed: join(root, "worlds"), prismGame: join(root, "prism"), minecraftSaves: join(root, "saves") })
    await mkdir(join(root, "worlds", "Corrupt"), { recursive: true })
    const places = Places({ directory: name => worlds.path({ name: name }) })
    await appendFile(join(root, "worlds", "Corrupt", ".axon-places.jsonl"), '{"kind":"removed"}\n')
    expect(places.list({ world: "Corrupt" })).rejects.toThrow("Invalid Minecraft place event")
})
