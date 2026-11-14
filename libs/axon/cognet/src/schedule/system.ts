import { err } from "@arcforge/err"
import { definitions, type Component, type Definition } from "../ecs"
import { clock, stimuli } from "./input"
import type { AuthoredSystem, AuthoredSystemSpec, Readable, System, SystemSpec } from "./types"

const made = new WeakSet<object>()

/** The constructor of every `async function`. A system whose run is one is async. */
const AsyncFunction = (async () => {}).constructor

/** Declare a system. The default export of every `*.system.ts` file. */
export function defineSystem(spec: SystemSpec): System
export function defineSystem(spec: AuthoredSystemSpec): AuthoredSystem
export function defineSystem(spec: AuthoredSystemSpec): AuthoredSystem {
    if (typeof spec.run !== "function") {
        throw err("COGNET_DISCOVERY_INVALID", { detail: "defineSystem() needs a run(tick) function" })
    }
    const system: AuthoredSystem = Object.freeze({ ...spec, kind: "system" as const })
    made.add(system)
    return system
}

/** Operations on systems that only the runtime performs. */
export const systems = {
    /** Whether `value` came from defineSystem(). */
    is(value: unknown): value is AuthoredSystem {
        return typeof value === "object" && value !== null && made.has(value)
    },

    /** Bind authored names to the one handle the schedule and isolation use. */
    resolve(system: AuthoredSystem): System {
        const readable = (value: Readable | string, on: boolean): Readable => {
            if (typeof value !== "string") return value
            if (value === "clock") {
                if (!on) throw err("COGNET_DISCOVERY_INVALID", { detail: '"clock" can run a system in on, but it is not a readable value' })
                return clock
            }
            if (value === "stimuli") return stimuli
            return definitions.resolve(value)
        }
        const component = (value: Component<any> | string): Component<any> => typeof value === "string" ? definitions.find(value) : value
        const definition = (value: Definition | string): Definition => typeof value === "string" ? definitions.resolve(value) : value
        const resolved: System = Object.freeze({
            kind: "system",
            run: system.run,
            ...(system.on !== undefined ? { on: system.on.map(value => readable(value, true)) } : {}),
            ...(system.once !== undefined ? { once: system.once } : {}),
            ...(system.reads !== undefined ? { reads: system.reads.map(value => readable(value, false)) } : {}),
            ...(system.recalls !== undefined ? { recalls: system.recalls.map(definition) } : {}),
            ...(system.streams !== undefined ? { streams: system.streams.map(component) } : {}),
            ...(system.writes !== undefined ? { writes: system.writes.map(component) } : {}),
            ...(system.uses !== undefined ? { uses: system.uses } : {}),
            ...(system.thread !== undefined ? { thread: system.thread } : {}),
            ...(system.lag !== undefined ? { lag: system.lag } : {}),
        })
        return resolved
    },

    /**
     * Whether a system runs asynchronously — `async run() { ... }`. Read from
     * the function itself, so the author declares nothing: writing `async` IS
     * the declaration, and the schedule knows before the first run.
     */
    async(system: System): boolean {
        return system.run instanceof AsyncFunction
    },
}
