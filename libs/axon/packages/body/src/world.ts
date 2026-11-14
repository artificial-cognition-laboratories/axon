import { err } from "@arcforge/err"
import { world as contract, type body } from "@arcforge/types"

type Said = contract.Said

const CODES: readonly contract.Code[] = ["BODY_NOT_FOUND", "WORLD_NOT_FOUND", "IMPORT_UNSUPPORTED", "IMPORT_FAILED", "CONTRACT_UNSAID", "PHYSICS", "REFUSED", "WIRE", "IO"]
const EVENTS: readonly contract.Event["kind"][] = ["unsound", "behind", "refused"]

/**
 * world — the world contract (atrium.world/0) at work: each line a world
 * says, read and checked, and rebuilt from the fields that were — so a world
 * that says something else is refused by name, never half-believed.
 */
export const world = {
    /** One line of a world's stdout. */
    said(line: string): Said {
        const fields = object(line)
        const read = Read(fields, line)
        switch (fields.type) {
            case "ready": {
                const said = read.text("contract")
                if (said !== contract.CONTRACT) refuse(`a world that speaks ${said}; this is ${contract.CONTRACT}`)
                return {
                    type: "ready",
                    contract: contract.CONTRACT,
                    version: read.text("version"),
                    mujoco: read.text("mujoco"),
                    world: read.text("world"),
                    bridge: read.text("bridge"),
                    view: read.text("view"),
                    timestep: read.number("timestep"),
                    pace: read.pace("pace"),
                }
            }
            case "reply":
                if (!("result" in fields)) refuse(`a reply with no result: ${line.slice(0, 200)}`)
                return { type: "reply", id: read.id("id"), result: fields.result }
            case "failed":
                return { type: "failed", id: fields.id === null ? null : read.id("id"), code: read.oneOf("code", CODES), message: read.text("message") }
            case "event":
                return { type: "event", kind: read.oneOf("kind", EVENTS), detail: read.text("detail"), time: read.number("time") }
            case "ticked":
                return { type: "ticked", time: read.number("time"), factor: read.number("factor") }
            default:
                return refuse(`a line that is not the world contract: ${line.slice(0, 200)}`)
        }
    },
}

function refuse(detail: string): never {
    throw err("WORLD_REFUSED", { detail: detail })
}

function object(line: string): Record<string, unknown> {
    let value: unknown
    try {
        value = JSON.parse(line)
    } catch (cause) {
        throw err("WORLD_REFUSED", { detail: `a line that is not JSON: ${line.slice(0, 200)}`, cause: cause })
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(`a line that is not an object: ${line.slice(0, 200)}`)
    return Object.fromEntries(Object.entries(value))
}

/** Typed reads of one line's fields, each refusing by name. */
function Read(fields: Record<string, unknown>, line: string) {
    const what = (key: string) => `the world's ${String(fields.type)} whose ${key} is ${JSON.stringify(fields[key])}: ${line.slice(0, 200)}`
    const read = {
        text(key: string): string {
            const held = fields[key]
            if (typeof held !== "string") refuse(what(key))
            return held
        },
        number(key: string): number {
            const held = fields[key]
            if (typeof held !== "number" || !Number.isFinite(held)) refuse(what(key))
            return held
        },
        id(key: string): number {
            const held = read.number(key)
            if (!Number.isInteger(held) || held < 0) refuse(what(key))
            return held
        },
        oneOf<T extends string>(key: string, allowed: readonly T[]): T {
            const found = allowed.find(option => option === fields[key])
            if (found === undefined) refuse(what(key))
            return found
        },
        pace(key: string): body.Pace {
            const held = fields[key]
            if (typeof held !== "object" || held === null) refuse(what(key))
            const pace = Object.fromEntries(Object.entries(held))
            if (pace.kind === "real" || pace.kind === "stepped") return { kind: pace.kind }
            if (pace.kind === "scaled" && typeof pace.factor === "number" && pace.factor >= 0) return { kind: "scaled", factor: pace.factor }
            return refuse(what(key))
        },
    }
    return read
}
