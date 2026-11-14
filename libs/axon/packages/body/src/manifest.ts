import { err } from "@arcforge/err"
import type { body } from "@arcforge/types"

type Manifest = body.Manifest

const CONTRACT = "axon.body/1"
/** How far a quaternion's length, or an axis's, may be from one and still be read as one. */
const UNIT = 1e-6
/** How many coefficients each of ROS's distortion models takes. */
const DISTORTIONS = { plumb_bob: 5, rational_polynomial: 8, equidistant: 4 } as const
/** Interfaces that drive a rate or a force: left applied, they run away, so their control may never keep. */
const RUNAWAY = ["velocity", "effort"]

/**
 * manifest — what a body says about itself, checked once at the boundary.
 *
 * `check` reads anything — parsed JSON from a socket — and either returns it
 * as a Manifest the rest of the system can trust, or throws naming the first
 * thing wrong by its path (`senses[2].components[0].unit`). Everything inside
 * the boundary then trusts it: no reader of a manifest ever re-checks it.
 */
export const manifest = {
    check(value: unknown): Manifest {
        const at = Reader(value, "manifest")
        const contract = at.field("contract").string()
        if (contract !== CONTRACT) {
            throw err("BODY_CONTRACT_UNKNOWN", { detail: `the body speaks ${contract}; this mind speaks ${CONTRACT}` })
        }
        at.field("kind").string()
        checks.clock(at.field("clock"))
        const places = checks.world(at.field("world"))

        const frames = at.field("frames").list()
        if (frames.length === 0) at.field("frames").fail("is empty — a body has at least its base")
        const named = checks.unique(frames.map(frame => frame.field("name")), "frame")
        for (const frame of frames) if (places.has(frame.field("name").string())) frame.field("name").fail("is also a place's name — a frame is the body's or the world's, never both")
        const roots = frames.filter(frame => frame.field("parent").nullable() === null)
        if (roots.length !== 1) at.field("frames").fail(`has ${roots.length} frames with no parent; exactly one is the body's base`)
        for (const frame of frames) checks.frame(frame, named)
        checks.acyclic(frames)
        const jointed = new Set(frames.filter(frame => frame.has("joint")).map(frame => frame.field("name").string()))
        const mimicking = new Set(frames.filter(frame => frame.has("joint") && frame.field("joint").has("mimic")).map(frame => frame.field("name").string()))
        for (const frame of frames) frame.optional("joint")?.optional("mimic")?.field("joint").member(jointed, "jointed frame")

        const senses = at.field("senses").list()
        checks.unique(senses.map(sense => sense.field("channel")), "sense channel")
        const readable = new Set([...named, ...places])
        for (const sense of senses) checks.sense(sense, readable)

        const controls = at.field("controls").list()
        checks.unique(controls.map(control => control.field("channel")), "control channel")
        const drivable = new Set([...jointed].filter(name => !mimicking.has(name)))
        for (const control of controls) checks.control(control, readable, drivable)

        // A body in no space — a shell, an account — is only its base: nothing in it has a place to be.
        if (at.field("world").field("space").field("dimensions").number() === 0) {
            if (frames.length !== 1) at.field("frames").fail("has more than the base, in a body of no space")
            for (const part of [...senses, ...controls]) if (part.has("frame")) part.field("frame").fail("is a frame, in a body of no space")
        }

        const skills = at.field("skills").list()
        checks.unique(skills.map(skill => skill.field("name")), "skill")
        for (const skill of skills) {
            skill.field("describe").string()
            skill.field("args").object()
            skill.field("result").object()
            skill.field("cancellable").boolean()
            skill.field("within").positive()
        }
        // Every path above has been read and found to be the contract's; this is the one place it is said so.
        return value as Manifest
    },
}

/** The parts of a manifest, each checked where it is read. */
const checks = {
    clock(clock: Read): void {
        if (clock.field("unit").string() !== "ms") clock.field("unit").fail("is not ms")
        clock.optional("step")?.positive()
        const pace = clock.field("pace")
        const kind = pace.field("kind").oneOf(["real", "scaled", "stepped"])
        if (kind === "scaled") pace.field("factor").nonNegative()
        if (kind === "stepped" && !clock.has("step")) pace.fail("is stepped, but the clock has no step to advance by")
    },

    /** The world, and the names of its places. */
    world(world: Read): Set<string> {
        const space = world.field("space")
        const dimensions = space.field("dimensions").number()
        if (dimensions === 2) space.field("plane").oneOf(["xz", "xy"])
        else if (dimensions === 3 || dimensions === 0) { if (space.has("plane")) space.field("plane").fail("is for a world of two dimensions") }
        else space.field("dimensions").fail("is not 0, 2 or 3")
        world.optional("gravity")?.positive()
        world.optional("anchored")?.boolean()
        const places = world.field("places").list()
        if (dimensions === 0 && (places.length > 0 || world.has("gravity"))) world.fail("has places or gravity, in no space")
        const named = checks.unique(places.map(place => place.field("name")), "place")
        for (const place of places) {
            if (place.field("kind").oneOf(["local", "geodetic"]) === "geodetic") place.field("datum").string()
        }
        return named
    },

    frame(frame: Read, named: Set<string>): void {
        const parent = frame.field("parent").nullable()
        if (parent !== null && !named.has(parent.string())) parent.fail(`names no frame of this body`)
        frame.field("axes").oneOf(["flu", "rdf"])
        frame.field("at").vector(3)
        frame.field("turn").unit(4)
        frame.optional("mass")?.positive()
        frame.optional("centre")?.vector(3)
        frame.optional("inertia")?.vector(6)
        const shape = frame.optional("shape")
        if (shape) {
            const kind = shape.field("kind").oneOf(["box", "cylinder", "sphere", "mesh"])
            if (kind === "box") shape.field("size").vector(3)
            if (kind === "cylinder") { shape.field("radius").positive(); shape.field("length").positive() }
            if (kind === "sphere") shape.field("radius").positive()
            if (kind === "mesh") { shape.field("ref").field("uri").string(); shape.optional("scale")?.vector(3) }
            const place = shape.optional("place")
            if (place) { place.field("at").vector(3); place.field("turn").unit(4) }
        }
        const joint = frame.optional("joint")
        if (joint) {
            if (parent === null) joint.fail("is on the base, which has no parent to move on")
            joint.optional("name")?.string()
            joint.field("type").oneOf(["revolute", "continuous", "prismatic", "planar", "floating"])
            joint.field("axis").unit(3)
            const limits = joint.optional("limits")
            if (limits) {
                limits.optional("position")?.range()
                limits.optional("velocity")?.positive()
                limits.optional("effort")?.positive()
            }
            const dynamics = joint.optional("dynamics")
            if (dynamics) { dynamics.optional("damping")?.nonNegative(); dynamics.optional("friction")?.nonNegative() }
            const mimic = joint.optional("mimic")
            if (mimic) {
                if (mimic.field("joint").string() === frame.field("name").string()) mimic.field("joint").fail("is the joint itself")
                mimic.field("multiplier").number()
                mimic.field("offset").number()
            }
        }
    },

    /** A sense, read in one of `readable` — the body's frames or the world's places. */
    sense(sense: Read, readable: Set<string>): void {
        sense.optional("frame")?.member(readable, "frame or place")
        sense.optional("rate")?.positive()
        sense.optional("profile")?.string()
        const kind = sense.field("kind").oneOf(["vector", "visual", "audio", "text"])
        if (kind === "vector") checks.components(sense.field("components"))
        if (kind === "visual") checks.picture(sense)
        if (kind === "audio") { sense.field("sampleRate").count(); sense.field("channels").count() }
        if (kind === "text") {
            const json = sense.optional("format")?.oneOf(["json"]) === "json"
            if (json) sense.field("schema").object()
            else if (sense.has("schema")) sense.field("schema").fail("is for a sense whose format is json")
        }
    },

    picture(sense: Read): void {
        const width = sense.field("width").count()
        const height = sense.field("height").count()
        const lens = sense.field("lens")
        const shape = lens.field("kind").oneOf(["perspective", "orthographic", "polar"])
        if (shape === "perspective") {
            for (const focal of lens.field("focal").numbers(2)) if (focal <= 0) lens.field("focal").fail("is not above zero")
            const [cx, cy] = lens.field("centre").numbers(2)
            if (cx! < 0 || cx! > width || cy! < 0 || cy! > height) lens.field("centre").fail("is off the picture")
            const distortion = lens.optional("distortion")
            if (distortion) {
                const model = distortion.field("model").oneOf(Object.keys(DISTORTIONS) as (keyof typeof DISTORTIONS)[])
                distortion.field("coefficients").vector(DISTORTIONS[model])
            }
        }
        if (shape === "orthographic") lens.field("scale").positive()
        if (shape === "polar") {
            lens.field("from").number()
            lens.field("to").number()
            const elevation = lens.field("elevation")
            if (elevation.isList()) elevation.vector(height)
            else { elevation.field("from").number(); elevation.field("to").number() }
        }
        const pixel = sense.field("pixel")
        const measures = pixel.field("kind").oneOf(["colour", "depth", "measure"])
        if (measures === "depth") pixel.field("range").positive()
        if (measures === "measure") { pixel.field("unit").string(); pixel.optional("range")?.range() }
        if (measures === "depth" && shape === "orthographic") pixel.fail("is depth through an orthographic lens, which has no axis to measure along")
    },

    /** A control, given in one of `readable` — the body's frames or the world's places — its joints among those `drivable`: jointed, and mimicking none. */
    control(control: Read, readable: Set<string>, drivable: Set<string>): void {
        control.optional("profile")?.string()
        const kind = control.field("kind").oneOf(["vector", "text", "audio"])
        if (kind === "vector") {
            control.optional("frame")?.member(readable, "frame or place")
            control.optional("rate")?.positive()
            const lapse = control.field("lapse")
            const lapses = lapse.field("kind").oneOf(["release", "keep", "behaviour"])
            if (lapses !== "keep") lapse.field("after").positive()
            if (lapses === "behaviour") { lapse.field("name").string(); lapse.field("describe").string() }
            const trajectory = control.optional("trajectory")
            if (trajectory) { trajectory.field("points").count(); trajectory.field("interpolation").oneOf(["step", "linear"]) }
            for (const component of checks.components(control.field("components"))) {
                const drives = component.field("interface").oneOf(["switch", "axis", "choice", "position", "velocity", "effort"])
                if ((drives === "choice") !== component.has("categories")) component.field("interface").fail(drives === "choice" ? "is a choice of no categories" : "is not a choice, but has categories")
                if (lapses === "keep" && RUNAWAY.includes(drives)) lapse.fail(`keeps ${component.field("name").string()}, a ${drives} — left applied it runs away`)
                component.optional("joint")?.member(drivable, "drivable joint")
                component.optional("slew")?.positive()
            }
        }
        if (kind === "audio") { control.field("sampleRate").count(); control.field("channels").count() }
    },

    components(at: Read): Read[] {
        const components = at.list()
        if (components.length === 0) at.fail("is empty — a reading or a command is at least one number")
        checks.unique(components.map(component => component.field("name")), "component")
        for (const component of components) {
            const unit = component.field("unit").string()
            component.optional("range")?.range()
            component.optional("noise")?.nonNegative()
            const categories = component.optional("categories")
            if ((unit === "category") !== (categories !== null)) component.field("unit").fail(unit === "category" ? "is category, but there are no categories" : "has categories, but is not category")
            if (categories) {
                if (categories.list().length === 0) categories.fail("is empty")
                checks.unique(categories.list(), "category")
            }
        }
        return components
    },

    /** The names read, refusing a repeat by path. */
    unique(names: Read[], what: string): Set<string> {
        const seen = new Set<string>()
        for (const name of names) {
            const value = name.string()
            if (seen.has(value)) name.fail(`repeats the ${what} "${value}"`)
            seen.add(value)
        }
        return seen
    },

    /** Refuses frames whose parents loop back on themselves: the frames must be a tree. */
    acyclic(frames: Read[]): void {
        const parents = new Map(frames.map(frame => [frame.field("name").string(), frame.field("parent").nullable()?.string() ?? null]))
        for (const frame of frames) {
            const seen = new Set<string>()
            let at: string | null = frame.field("name").string()
            while (at !== null) {
                if (seen.has(at)) frame.field("parent").fail(`loops back to "${at}" — frames must form a tree`)
                seen.add(at)
                at = parents.get(at) ?? null
            }
        }
    },
}

/** One value of an unchecked document, and its path — every check names where it failed. */
type Read = {
    fail(message: string): never
    object(): Record<string, unknown>
    number(): number
    has(key: string): boolean
    isList(): boolean
    field(key: string): Read
    optional(key: string): Read | null
    nullable(): Read | null
    list(): Read[]
    string(): string
    boolean(): boolean
    oneOf<T extends string>(allowed: readonly T[]): T
    member(names: Set<string>, what: string): void
    positive(): void
    nonNegative(): void
    count(): number
    numbers(length: number): number[]
    vector(length: number): void
    unit(length: number): void
    range(): void
}

function Reader(value: unknown, path: string): Read {
    function fail(message: string): never {
        throw err("BODY_MANIFEST_INVALID", { detail: `${path} ${message}` })
    }
    function object(): Record<string, unknown> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) fail("is not an object")
        return value as Record<string, unknown>
    }
    function number(): number {
        if (typeof value !== "number" || !Number.isFinite(value)) fail("is not a finite number")
        return value as number
    }
    function numbers(length: number): number[] {
        if (!Array.isArray(value) || value.length !== length) fail(`is not ${length} numbers`)
        return (value as unknown[]).map((item, index) => Reader(item, `${path}[${index}]`).number())
    }
    const self: Read = {
        fail: fail,
        object: object,
        number: number,
        has(key: string): boolean {
            return object()[key] !== undefined
        },
        isList(): boolean {
            return Array.isArray(value)
        },
        field(key: string): Read {
            const held = object()[key]
            if (held === undefined) throw err("BODY_MANIFEST_INVALID", { detail: `${path}.${key} is missing` })
            return Reader(held, `${path}.${key}`)
        },
        optional(key: string): Read | null {
            const held = object()[key]
            return held === undefined ? null : Reader(held, `${path}.${key}`)
        },
        nullable(): Read | null {
            return value === null ? null : self
        },
        list(): Read[] {
            if (!Array.isArray(value)) fail("is not a list")
            return (value as unknown[]).map((item, index) => Reader(item, `${path}[${index}]`))
        },
        string(): string {
            if (typeof value !== "string" || value.length === 0) fail("is not a non-empty string")
            return value as string
        },
        boolean(): boolean {
            if (typeof value !== "boolean") fail("is not true or false")
            return value as boolean
        },
        oneOf<T extends string>(allowed: readonly T[]): T {
            if (!allowed.includes(value as T)) fail(`is ${JSON.stringify(value)}, not one of ${allowed.join(", ")}`)
            return value as T
        },
        member(names: Set<string>, what: string): void {
            if (!names.has(self.string())) fail(`names no ${what} of this body`)
        },
        positive(): void {
            if (number() <= 0) fail("is not above zero")
        },
        nonNegative(): void {
            if (number() < 0) fail("is below zero")
        },
        count(): number {
            if (!Number.isInteger(number()) || number() <= 0) fail("is not a whole number above zero")
            return number()
        },
        numbers: numbers,
        vector(length: number): void {
            numbers(length)
        },
        unit(length: number): void {
            const length2 = numbers(length).reduce((sum, component) => sum + component * component, 0)
            if (Math.abs(Math.sqrt(length2) - 1) > UNIT) fail("is not of length one")
        },
        range(): void {
            const [low, high] = numbers(2)
            if (low! > high!) fail("runs from above to below")
        },
    }
    return self
}
