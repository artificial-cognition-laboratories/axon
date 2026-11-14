import { randomUUID } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { MinecraftPlace } from "../../types"

type PlaceEvent = { kind: "placed"; place: MinecraftPlace } | { kind: "removed"; id: string }
type Position = Pick<MinecraftPlace, "x" | "y" | "z">

/** Durable named coordinates for authoring a managed world. Not agent observations. */
export function Places(opts: { directory: (world: string) => Promise<string> }) {
    async function file(world: string): Promise<string> {
        return join(await opts.directory(world), ".axon-places.jsonl")
    }

    async function list(input: { world: string }): Promise<MinecraftPlace[]> {
        const path = await file(input.world)
        let contents: string
        try {
            contents = await readFile(path, "utf-8")
        } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return []
            throw cause
        }
        const places = new Map<string, MinecraftPlace>()
        for (const line of contents.split("\n").filter(Boolean)) {
            const event = parseEvent(line, path)
            if (event.kind === "placed") places.set(event.place.id, event.place)
            else if (event.kind === "removed") places.delete(event.id)
            else throw new Error(`Invalid Minecraft place event in ${path}`)
        }
        return [...places.values()]
    }

    async function record(world: string, event: PlaceEvent): Promise<void> {
        await appendFile(await file(world), JSON.stringify(event) + "\n")
    }

    return {
        list: list,
        async add(input: { world: string; name: string } & Position): Promise<MinecraftPlace> {
            const name = input.name.trim()
            if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error("A place needs a name of 1–80 visible characters")
            if (![input.x, input.y, input.z].every(Number.isFinite)
                || Math.abs(input.x) > 30_000_000 || input.y < -64 || input.y > 320 || Math.abs(input.z) > 30_000_000) {
                throw new Error("Place coordinates are outside Minecraft's world bounds")
            }
            const place: MinecraftPlace = { id: randomUUID(), name: name, x: input.x, y: input.y, z: input.z, createdAt: new Date().toISOString() }
            await record(input.world, { kind: "placed", place: place })
            return place
        },
        async remove(input: { world: string; id: string }): Promise<void> {
            if (!(await list({ world: input.world })).some(place => place.id === input.id)) throw new Error(`Place ${input.id} is not in ${input.world}`)
            await record(input.world, { kind: "removed", id: input.id })
        },
    }
}

export type PlacesT = ReturnType<typeof Places>

function parseEvent(line: string, path: string): PlaceEvent {
    const value: unknown = JSON.parse(line)
    if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error(`Invalid Minecraft place event in ${path}`)
    if (value.kind === "removed" && "id" in value && typeof value.id === "string") return { kind: "removed", id: value.id }
    if (value.kind === "placed" && "place" in value && typeof value.place === "object" && value.place !== null) {
        const place = value.place
        if ("id" in place && typeof place.id === "string" && "name" in place && typeof place.name === "string"
            && "x" in place && typeof place.x === "number" && Number.isFinite(place.x)
            && "y" in place && typeof place.y === "number" && Number.isFinite(place.y)
            && "z" in place && typeof place.z === "number" && Number.isFinite(place.z)
            && "createdAt" in place && typeof place.createdAt === "string") {
            return { kind: "placed", place: { id: place.id, name: place.name, x: place.x, y: place.y, z: place.z, createdAt: place.createdAt } }
        }
    }
    throw new Error(`Invalid Minecraft place event in ${path}`)
}
