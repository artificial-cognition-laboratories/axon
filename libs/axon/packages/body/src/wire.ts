import { err } from "@arcforge/err"
import type { body } from "@arcforge/types"
import { manifest as manifests } from "./manifest"

type Manifest = body.Manifest
type FromBody = body.FromBody
type ToBody = body.ToBody

/**
 * What a body's manifest declares, indexed once, for checking every message
 * against: each sense's kind and width, each control's, the skills, and
 * whether the body waits to be stepped.
 */
export type Channels = {
    senses: Map<string, { kind: body.Sense["kind"]; width: number | null; json: boolean }>
    controls: Map<string, { kind: body.Control["kind"]; width: number | null; points: number | null }>
    skills: Set<string>
    stepped: boolean
}

/**
 * wire — the messages a body and a mind exchange, read off a socket and
 * checked: against the contract, and — once the body has said what it is —
 * against its manifest. A reading on a channel the body never declared, a
 * command with the wrong number of values, or a skill it has not, is refused
 * by name rather than delivered for a mind to misread.
 *
 * Every message is rebuilt from the fields that were checked, so nothing
 * unchecked rides along to whoever reads it next.
 */
export const wire = {
    /** A manifest's channels, indexed for checking messages against. */
    channels(described: Manifest): Channels {
        return {
            senses: new Map(described.senses.map(sense => [sense.channel, { kind: sense.kind, width: sense.kind === "vector" ? sense.components.length : null, json: sense.kind === "text" && sense.format === "json" }])),
            controls: new Map(described.controls.map(control => [control.channel, {
                kind: control.kind,
                width: control.kind === "vector" ? control.components.length : null,
                points: control.kind === "vector" && control.trajectory ? control.trajectory.points : null,
            }])),
            skills: new Set(described.skills.map(skill => skill.name)),
            stepped: described.clock.pace.kind === "stepped",
        }
    },

    /**
     * One message from a body. Before its manifest (`channels` null) only the
     * manifest itself and presence may arrive: a reading of a body nobody has
     * described yet means nothing.
     */
    fromBody(text: string, channels: Channels | null): FromBody {
        const message = Message(text)
        switch (message.type) {
            case "manifest":
                return { type: "manifest", manifest: manifests.check(message.field("manifest")) }
            case "presence": {
                const state = message.oneOf("state", ["embodied", "held", "overridden", "detached"])
                if (state === "embodied") return { type: "presence", state: state }
                return { type: "presence", state: state, why: message.text("why") }
            }
        }
        if (!channels) refuse(`a ${message.type} before the body's manifest`)
        switch (message.type) {
            case "reading": {
                const channel = message.text("channel")
                const sense = channels.senses.get(channel)
                if (!sense) refuse(`a reading on ${channel}, which the body declared no sense on`)
                const reading: body.Reading = { type: "reading", channel: channel, seq: message.counter("seq"), sensed: message.stamp("sensed") }
                if (sense.kind === "vector") reading.values = message.values("values", sense.width!, `reading on ${channel}`)
                else if (sense.kind === "text") reading.text = sense.json ? message.json("text", `reading on ${channel}`) : message.text("text")
                else reading.ref = message.ref("ref", `reading on ${channel}`)
                return reading
            }
            case "truth": {
                const components = message.components("components")
                return { type: "truth", sensed: message.stamp("sensed"), components: components, values: message.values("values", components.length, "truth") }
            }
            case "applied": {
                const channel = message.text("channel")
                const control = channels.controls.get(channel)
                if (!control) refuse(`applied on ${channel}, which the body declared no control on`)
                const applied: body.Applied = { type: "applied", channel: channel, seq: message.counter("seq"), sensed: message.stamp("sensed") }
                if (message.has("point")) {
                    if (control.points === null) refuse(`applied of a point on ${channel}, which takes no trajectories`)
                    applied.point = message.counter("point")
                }
                if (control.kind === "vector") applied.values = message.values("values", control.width!, `applied on ${channel}`)
                return applied
            }
            case "skill": {
                const update: body.SkillUpdate = { type: "skill", id: message.text("id"), state: message.oneOf("state", ["running", "succeeded", "failed", "cancelled"]) }
                if (message.has("progress")) update.progress = message.field("progress")
                if (message.has("result")) update.result = message.field("result")
                if (message.has("error")) update.error = message.text("error")
                return update
            }
            case "waiting":
                if (!channels.stepped) refuse("waiting, from a body whose pace is not stepped")
                return { type: "waiting", sensed: message.stamp("sensed") }
        }
        return refuse(`a message of type ${JSON.stringify(message.type)}`)
    },

    /** One message from a mind, checked against the body it is for. */
    toBody(text: string, channels: Channels): ToBody {
        const message = Message(text)
        switch (message.type) {
            case "command": {
                const channel = message.text("channel")
                const control = channels.controls.get(channel)
                if (!control) refuse(`a command on ${channel}, which the body declared no control on`)
                const command: body.Command = { type: "command", channel: channel, seq: message.counter("seq") }
                if (message.has("basis")) command.basis = message.stamp("basis")
                if (control.kind === "vector" && message.has("trajectory")) command.trajectory = message.trajectory(control.width!, control.points, channel)
                else if (control.kind === "vector") command.values = message.values("values", control.width!, `command on ${channel}`)
                else if (control.kind === "text") command.text = message.text("text")
                else command.ref = message.ref("ref", `command on ${channel}`)
                return command
            }
            case "skill": {
                const name = message.text("name")
                if (!channels.skills.has(name)) refuse(`a request for skill ${name}, which the body declared no skill of`)
                return { type: "skill", id: message.text("id"), name: name, args: message.field("args") }
            }
            case "cancel":
                return { type: "cancel", id: message.text("id") }
            case "step":
                if (!channels.stepped) refuse("a step, to a body whose pace is not stepped")
                return { type: "step", steps: message.count("steps") }
        }
        return refuse(`a message of type ${JSON.stringify(message.type)}`)
    },

    encode(message: FromBody | ToBody): string {
        return JSON.stringify(message)
    },
}

function refuse(what: string): never {
    throw err("BODY_MESSAGE_INVALID", { detail: `refused ${what}` })
}

/** One message off the wire, parsed, and each field read as what it must be — refusing, by name, what is not. */
function Message(text: string) {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch (cause) {
        throw err("BODY_MESSAGE_INVALID", { detail: `refused a message that is not JSON: ${text.slice(0, 80)}`, cause: cause })
    }
    const fields = values.object(value, `message ${text.slice(0, 80)}`)
    const type = fields.type
    if (typeof type !== "string") refuse(`a message with no type: ${text.slice(0, 80)}`)

    const message = {
        type: type,
        has(key: string): boolean {
            return fields[key] !== undefined
        },
        field(key: string): unknown {
            if (fields[key] === undefined) refuse(`a ${type} with no ${key}`)
            return fields[key]
        },
        text(key: string): string {
            const held = fields[key]
            if (typeof held !== "string") refuse(`a ${type} whose ${key} is not text`)
            return held
        },
        oneOf<T extends string>(key: string, allowed: readonly T[]): T {
            const held = fields[key]
            const found = allowed.find(option => option === held)
            if (found === undefined) refuse(`a ${type} whose ${key} is ${JSON.stringify(held)}, not one of ${allowed.join(", ")}`)
            return found
        },
        counter(key: string): number {
            return values.counter(fields[key], `${type}'s ${key}`)
        },
        count(key: string): number {
            const held = values.counter(fields[key], `${type}'s ${key}`)
            if (held === 0) refuse(`a ${type} whose ${key} is 0`)
            return held
        },
        stamp(key: string): number {
            return values.stamp(fields[key], `${type}'s ${key}`)
        },
        values(key: string, width: number, what: string): number[] {
            return values.numbers(fields[key], width, what)
        },
        /** Text that must parse as JSON — a structured sense's reading. */
        json(key: string, what: string): string {
            const held = message.text(key)
            try {
                JSON.parse(held)
            } catch (cause) {
                throw err("BODY_MESSAGE_INVALID", { detail: `refused a ${what} whose text is not JSON: ${held.slice(0, 80)}`, cause: cause })
            }
            return held
        },
        ref(key: string, what: string): body.Ref {
            if (fields[key] === undefined) refuse(`a ${what} with no ref to its bytes`)
            const held = values.object(fields[key], `${what}'s ref`)
            if (typeof held.uri !== "string" || typeof held.mime !== "string") refuse(`a ${what} with no ref to its bytes`)
            const ref: body.Ref = { uri: held.uri, mime: held.mime }
            if (held.bytes !== undefined) ref.bytes = values.counter(held.bytes, `${what}'s bytes`)
            return ref
        },
        /** A truth's components: each named, in a unit. */
        components(key: string): body.Component[] {
            const held = fields[key]
            if (!Array.isArray(held)) refuse(`a ${type} with no ${key}`)
            return held.map((component: unknown, index) => {
                const named = values.object(component, `${type}'s component ${index}`)
                if (typeof named.name !== "string" || typeof named.unit !== "string") refuse(`a ${type} whose component ${index} has no name or unit`)
                return { name: named.name, unit: named.unit }
            })
        },
        /** A planned command: up to `points` points, each `width` values, in order of time. */
        trajectory(width: number, points: number | null, channel: string): { at: number; values: number[] }[] {
            if (points === null) refuse(`a trajectory on ${channel}, which takes none`)
            const held = fields.trajectory
            if (!Array.isArray(held) || held.length === 0) refuse(`a trajectory on ${channel} with no points`)
            if (held.length > points) refuse(`a trajectory of ${held.length} points on ${channel}, which takes at most ${points}`)
            let last = -Infinity
            return held.map((point: unknown, index) => {
                const timed = values.object(point, `trajectory on ${channel}'s point ${index}`)
                const at = values.stamp(timed.at, `point ${index}'s at`)
                if (at <= last) refuse(`a trajectory on ${channel} whose point ${index} is not after the one before`)
                last = at
                return { at: at, values: values.numbers(timed.values, width, `point ${index} on ${channel}`) }
            })
        },
    }
    return message
}

/** What a value on the wire must be. */
const values = {
    object(value: unknown, what: string): Record<string, unknown> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(`a ${what} that is not an object`)
        return Object.fromEntries(Object.entries(value))
    },
    counter(value: unknown, what: string): number {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) refuse(`a ${what} of ${JSON.stringify(value)}`)
        return value
    },
    stamp(value: unknown, what: string): number {
        if (typeof value !== "number" || !Number.isFinite(value)) refuse(`a ${what} of ${JSON.stringify(value)}`)
        return value
    },
    numbers(value: unknown, width: number, what: string): number[] {
        if (!Array.isArray(value) || value.length !== width) refuse(`a ${what} of ${Array.isArray(value) ? value.length : "no"} values, where ${width} are declared`)
        return value.map((item: unknown) => {
            if (typeof item !== "number" || !Number.isFinite(item)) refuse(`a ${what} holding ${JSON.stringify(item)}`)
            return item
        })
    },
}
