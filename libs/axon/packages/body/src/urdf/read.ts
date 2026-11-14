import { XMLParser } from "fast-xml-parser"
import { err } from "@arcforge/err"
import type { body } from "@arcforge/types"
import { rotation } from "./rotation"
import { sensors } from "./sensors"
import type { Element, Skeleton } from "./types"

type Frame = body.Frame
type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

/** Every element that may repeat, read as a list even when there is one. */
const LISTS = new Set(["link", "joint", "ros2_control", "command_interface", "state_interface", "param", "visual", "collision", "gazebo", "sensor"])
/** Units each joint type is driven and read in. */
const UNITS: Record<string, { position: string; velocity: string; effort: string }> = {
    revolute: { position: "rad", velocity: "rad/s", effort: "N·m" },
    continuous: { position: "rad", velocity: "rad/s", effort: "N·m" },
    prismatic: { position: "m", velocity: "m/s", effort: "N" },
}
const INTERFACES = ["position", "velocity", "effort"] as const
const MOVING = ["revolute", "continuous", "prismatic", "planar", "floating"]
/** Where a skeleton's driven joints are commanded and read, when it comes from URDF. */
const JOINTS_CHANNEL = "/joints"
/** The link ROS and Gazebo take for the world itself: a robot joined to it is fixed there, or free in it. */
const WORLD = "world"

/**
 * A skeleton, from URDF text.
 *
 * What maps: every link is a Frame, every joint the Joint of its child frame,
 * placed by the joint's origin; a mimic joint mimics the frame its joint
 * moves; a link's inertial is its mass, centre and inertia; its first
 * collision geometry (or visual, when it has none) is its shape. A
 * `<ros2_control>` block's command interfaces become one vector Control on
 * `/joints`, and its state interfaces a `sensor_msgs/JointState` Sense on
 * `/joints`. Gazebo's `<sensor>`s become senses (see `sensors`). A link named
 * `world` is the world, not the body: joined to the body by a fixed joint,
 * the body is anchored; by a floating one, free.
 *
 * What does not: URDF has no notion of a camera's optical axes — a link named
 * `…optical_frame` (ROS's convention, REP 103) is read as `rdf`, every other
 * as `flu`. One shape a link: further visuals and collisions are not kept. A
 * fixed joint's own name is not kept. Where a world-fixed robot is mounted is
 * a place in the world, not part of the body, and is not kept.
 *
 * `lapse` is what every driven joint does when its mind goes quiet: URDF has
 * no such notion, and none is assumed for a body.
 */
export function read(xml: string, opts: { lapse: body.Lapse }): Skeleton {
    const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, isArray: (name, _path, _leaf, isAttribute) => !isAttribute && LISTS.has(name) }).parse(xml) as { robot?: Element }
    const robot = document.robot
    if (!robot) fail("there is no <robot>")
    const world = parse.world(robot.link ?? [], robot.joint ?? [])
    const links: Element[] = (robot.link ?? []).filter((link: Element) => link.name !== WORLD)
    const joints: Element[] = (robot.joint ?? []).filter((joint: Element) => joint !== world.joint)
    const children = new Map(joints.map(joint => [parse.attribute(joint.child, "link", `joint ${joint.name}`), joint]))
    const roots = links.filter(link => !children.has(link.name))
    if (roots.length !== 1) fail(`${roots.length} links are no joint's child; exactly one is the base`)
    const moves = new Map(joints.map(joint => [joint.name as string, parse.attribute(joint.child, "link", `joint ${joint.name}`)]))

    const frames: Frame[] = links.map(link => parse.frame(link, children.get(link.name), moves))
    const sensed = sensors.read(robot, new Set(links.map(link => link.name as string)))
    const driven = parse.driven(robot.ros2_control ?? [], joints, opts.lapse)
    return {
        name: robot.name ?? "robot",
        frames: [...frames, ...sensed.frames],
        controls: driven.controls,
        senses: [...driven.senses, ...sensed.senses],
        anchored: world.anchored,
        places: sensed.places,
    }
}

function fail(detail: string): never {
    throw err("BODY_URDF_INVALID", { detail: detail })
}

/** What each part of a URDF document means, read. */
const parse = {
    /** The `world` link, if there is one, and the joint that joins the body to it. */
    world(links: Element[], joints: Element[]): { joint: Element | null; anchored: boolean } {
        const world = links.find(link => link.name === WORLD)
        if (!world) return { joint: null, anchored: false }
        if (world.inertial || world.visual || world.collision) fail("link world has mass or shape; the world is not part of the body")
        const joined = joints.filter(joint => joint.parent?.link === WORLD)
        if (joined.length !== 1) fail(`${joined.length} joints hang from the world; a body is joined to it once`)
        const joint = joined[0]!
        if (joints.some(other => other.child?.link === WORLD)) fail("the world is a joint's child; it can only be the root")
        if (joint.type === "fixed") return { joint: joint, anchored: true }
        if (joint.type === "floating") return { joint: joint, anchored: false }
        return fail(`the body is joined to the world by a ${joint.type} joint; a body moving on the world along a joint is not described yet`)
    },

    frame(link: Element, joint: Element | undefined, moves: Map<string, string>): Frame {
        const placed = joint ? parse.origin(joint.origin) : { at: [0, 0, 0] as Vec3, turn: [0, 0, 0, 1] as Quat }
        const frame: Frame = {
            name: link.name,
            parent: joint ? parse.attribute(joint.parent, "link", `joint ${joint.name}`) : null,
            axes: /optical_frame$/.test(link.name) ? "rdf" : "flu",
            at: placed.at,
            turn: placed.turn,
        }
        if (joint && joint.type !== "fixed") frame.joint = parse.moving(joint, link.name, moves)
        const inertial = link.inertial
        const mass = inertial ? parse.number(parse.attribute(inertial.mass, "value", `link ${link.name}'s mass`), `link ${link.name}'s mass`) : 0
        if (mass < 0) fail(`link ${link.name} has a mass below zero`)
        // A mass of zero is how URDF writes a link of no matter — a flange, a foot's contact point — not a weightless part.
        if (inertial && mass > 0) {
            frame.mass = mass
            const centre = parse.origin(inertial.origin)
            if (centre.at.some(value => value !== 0)) frame.centre = centre.at
            // URDF cannot say "a mass, no inertia" — it writes zeros — so zeros are read as a point mass.
            const inertia = inertial.inertia ? parse.tensor(inertial.inertia, link.name) : null
            if (inertia && inertia.some(value => value !== 0)) frame.inertia = parse.inertia(inertia, centre.turn)
        }
        const geometry = (link.collision ?? link.visual)?.[0]
        if (geometry) frame.shape = parse.shape(geometry, link.name)
        return frame
    },

    /** The joints a `<ros2_control>` block drives and reads, as one control and one sense on `/joints`. */
    driven(blocks: Element[], joints: Element[], lapse: body.Lapse): { controls: body.Control[]; senses: body.Sense[] } {
        const types = new Map(joints.map(joint => [joint.name, joint]))
        const commands: body.ControlComponent[] = []
        const states: body.Component[] = []
        for (const joint of blocks.flatMap(block => (block.joint ?? []) as Element[])) {
            const described = types.get(joint.name)
            if (!described) fail(`<ros2_control> drives joint ${joint.name}, which the robot does not have`)
            const units = UNITS[described.type]
            if (!units) fail(`<ros2_control> drives ${described.type} joint ${joint.name}; only revolute, continuous and prismatic joints are driven`)
            if (described.mimic) fail(`<ros2_control> drives joint ${joint.name}, which mimics another and is never driven itself`)
            const frame = parse.attribute(described.child, "link", `joint ${joint.name}`)
            for (const command of (joint.command_interface ?? []) as Element[]) {
                const kind = parse.interface(command.name, joint.name)
                const params = parse.parameters(command)
                const range = params.min !== undefined && params.max !== undefined ? [params.min, params.max] as [number, number] : parse.limit(described, kind)
                commands.push({ name: `${joint.name}.${kind}`, unit: units[kind], interface: kind, joint: frame, ...(range ? { range: range } : {}) })
            }
            for (const state of (joint.state_interface ?? []) as Element[]) {
                const kind = parse.interface(state.name, joint.name)
                states.push({ name: `${joint.name}.${kind}`, unit: units[kind] })
            }
        }
        return {
            controls: commands.length > 0 ? [{ channel: JOINTS_CHANNEL, kind: "vector", lapse: lapse, components: commands }] : [],
            senses: states.length > 0 ? [{ channel: JOINTS_CHANNEL, kind: "vector", profile: "sensor_msgs/JointState", components: states }] : [],
        }
    },

    attribute(element: Element | undefined, key: string, what: string): string {
        const value = element?.[key]
        if (typeof value !== "string" || value === "") fail(`${what} has no ${key}`)
        return value
    },

    number(text: string, what: string): number {
        const value = Number(text)
        if (!Number.isFinite(value)) fail(`${what} is not a number: ${text}`)
        return value
    },

    numbers(text: string | undefined, length: number, what: string): number[] {
        if (text === undefined) return new Array(length).fill(0)
        const values = text.trim().split(/\s+/).map(part => parse.number(part, what))
        if (values.length !== length) fail(`${what} is not ${length} numbers: ${text}`)
        return values
    },

    /** An `<origin xyz rpy>`, as a place and a turn. */
    origin(element: Element | undefined): { at: Vec3; turn: Quat } {
        const [x, y, z] = parse.numbers(element?.xyz, 3, "an origin's xyz")
        const [roll, pitch, yaw] = parse.numbers(element?.rpy, 3, "an origin's rpy")
        return { at: [x!, y!, z!], turn: rotation.fromRpy(roll!, pitch!, yaw!) }
    },

    /** A joint that moves, `moves` naming the frame each joint moves — what a mimic joint follows. */
    moving(joint: Element, link: string, moves: Map<string, string>): body.Joint {
        const type = joint.type
        if (!MOVING.includes(type)) fail(`joint ${joint.name} is of unknown type ${type}`)
        const [x, y, z] = parse.numbers(joint.axis?.xyz ?? "1 0 0", 3, `joint ${joint.name}'s axis`)
        const length = Math.hypot(x!, y!, z!)
        if (length === 0) fail(`joint ${joint.name}'s axis has no length`)
        const described: body.Joint = { type: type, axis: [x! / length, y! / length, z! / length] }
        if (joint.name !== link) described.name = joint.name
        const limit = joint.limit
        if (limit) {
            described.limits = {}
            if (type !== "continuous" && limit.lower !== undefined && limit.upper !== undefined) described.limits.position = [parse.number(limit.lower, `joint ${joint.name}'s lower limit`), parse.number(limit.upper, `joint ${joint.name}'s upper limit`)]
            if (limit.velocity !== undefined && parse.number(limit.velocity, "a velocity limit") > 0) described.limits.velocity = parse.number(limit.velocity, "a velocity limit")
            if (limit.effort !== undefined && parse.number(limit.effort, "an effort limit") > 0) described.limits.effort = parse.number(limit.effort, "an effort limit")
        }
        const dynamics = joint.dynamics
        if (dynamics) {
            described.dynamics = {}
            if (dynamics.damping !== undefined) described.dynamics.damping = parse.number(dynamics.damping, "damping")
            if (dynamics.friction !== undefined) described.dynamics.friction = parse.number(dynamics.friction, "friction")
        }
        const mimic = joint.mimic
        if (mimic) {
            const followed = moves.get(parse.attribute(mimic, "joint", `joint ${joint.name}'s mimic`))
            if (!followed) fail(`joint ${joint.name} mimics ${mimic.joint}, which the robot does not have`)
            described.mimic = {
                joint: followed,
                multiplier: mimic.multiplier === undefined ? 1 : parse.number(mimic.multiplier, `joint ${joint.name}'s mimic multiplier`),
                offset: mimic.offset === undefined ? 0 : parse.number(mimic.offset, `joint ${joint.name}'s mimic offset`),
            }
        }
        return described
    },

    tensor(inertia: Element, link: string): [number, number, number, number, number, number] {
        const read = (key: string) => parse.number(parse.attribute(inertia, key, `link ${link}'s inertia`), `link ${link}'s ${key}`)
        return [read("ixx"), read("ixy"), read("ixz"), read("iyy"), read("iyz"), read("izz")]
    },

    shape(element: Element, link: string): body.Shape {
        const geometry = element.geometry
        const placed = parse.origin(element.origin)
        const place = placed.at.some(value => value !== 0) || placed.turn[3] !== 1 ? { place: placed } : {}
        if (geometry?.box) return { kind: "box", size: parse.numbers(geometry.box.size, 3, `link ${link}'s box`) as Vec3, ...place }
        if (geometry?.cylinder) return { kind: "cylinder", radius: parse.number(geometry.cylinder.radius, "a radius"), length: parse.number(geometry.cylinder.length, "a length"), ...place }
        if (geometry?.sphere) return { kind: "sphere", radius: parse.number(geometry.sphere.radius, "a radius"), ...place }
        if (geometry?.mesh) {
            const scale = geometry.mesh.scale ? { scale: parse.numbers(geometry.mesh.scale, 3, "a mesh's scale") as Vec3 } : {}
            return { kind: "mesh", ref: { uri: parse.attribute(geometry.mesh, "filename", `link ${link}'s mesh`), mime: "model/mesh" }, ...scale, ...place }
        }
        return fail(`link ${link} has a geometry this contract cannot describe`)
    },

    interface(name: string, joint: string): (typeof INTERFACES)[number] {
        if (!(INTERFACES as readonly string[]).includes(name)) fail(`joint ${joint} has a ${name} interface; only position, velocity and effort are driven or read`)
        return name as (typeof INTERFACES)[number]
    },

    parameters(element: Element): { min?: number; max?: number } {
        const found: { min?: number; max?: number } = {}
        for (const param of (element.param ?? []) as Element[]) {
            const text = typeof param === "object" ? param["#text"] : undefined
            if ((param.name === "min" || param.name === "max") && text !== undefined) found[param.name as "min" | "max"] = parse.number(String(text), `param ${param.name}`)
        }
        return found
    },

    limit(joint: Element, kind: (typeof INTERFACES)[number]): [number, number] | null {
        const limit = joint.limit
        if (!limit) return null
        if (kind === "position") return joint.type === "continuous" || limit.lower === undefined ? null : [parse.number(limit.lower, "a lower limit"), parse.number(limit.upper, "an upper limit")]
        const bound = limit[kind]
        return bound === undefined || Number(bound) === 0 ? null : [-parse.number(bound, `a ${kind} limit`), parse.number(bound, `a ${kind} limit`)]
    },

    /** Rotates an inertia tensor given about an inertial frame turned by `turn` into the link's own axes: R I Rᵀ. */
    inertia(inertia: [number, number, number, number, number, number], turn: Quat): [number, number, number, number, number, number] {
        if (turn[3] === 1) return inertia
        const [ixx, ixy, ixz, iyy, iyz, izz] = inertia
        const I = [[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]]
        const R = rotation.matrix(turn)
        const RI = R.map(row => [0, 1, 2].map(column => row[0]! * I[0]![column]! + row[1]! * I[1]![column]! + row[2]! * I[2]![column]!))
        const out = RI.map(row => [0, 1, 2].map(column => row[0]! * R[column]![0]! + row[1]! * R[column]![1]! + row[2]! * R[column]![2]!))
        return [out[0]![0]!, out[0]![1]!, out[0]![2]!, out[1]![1]!, out[1]![2]!, out[2]![2]!]
    },
}
