import type { body } from "@arcforge/types"
import { imu, LOOKING_FORWARD, REAL, STILL } from "./parts"

/**
 * A Mars rover, shaped as Curiosity and Perseverance are: six wheels on a
 * rocker-bogie, the four corners steered, a mast that pans and tilts with
 * stereo navigation cameras, fisheye hazard cameras on the body.
 *
 * Its mind is on Earth, eight to forty-eight minutes away and back. So it is
 * never driven a command at a time: a sol's drive goes up as one trajectory,
 * the rest as skills that take hours, and when the link is quiet the drive
 * lets go. It localises itself to the site's map, not to the planet; it knows
 * the sun's direction, not north. At night it holds (presence `held`),
 * keeping warm.
 */
const CORNERS = ["front.left", "front.right", "rear.left", "rear.right"] as const
const WHEELS = ["front.left", "middle.left", "rear.left", "front.right", "middle.right", "rear.right"] as const
const SIDE = { left: 1, right: -1 } as const
/** The navigation cameras: 1280×960 with a 45° field of view, as Perseverance's Navcams; plumb-bob distortion from calibration. */
const NAVCAM: body.Lens = { kind: "perspective", focal: [1545, 1545], centre: [640.5, 480.5], distortion: { model: "plumb_bob", coefficients: [-0.21, 0.08, 0.0002, -0.0001, 0] } }
/** The half-angle's cosine and sine of the hazard camera's 30° tilt down. */
const TILT = { c: Math.cos(Math.PI / 12), s: Math.sin(Math.PI / 12) }
const HAZCAM: body.Lens = { kind: "perspective", focal: [480, 480], centre: [640, 480], distortion: { model: "equidistant", coefficients: [0.012, -0.004, 0.0006, -0.0001] } }

function side(name: string): 1 | -1 {
    return name.endsWith("left") ? SIDE.left : SIDE.right
}

export const ROVER: body.Manifest = {
    contract: "axon.body/1",
    kind: "jpl:mars-rover",
    clock: { unit: "ms", pace: REAL },
    world: {
        space: { dimensions: 3 },
        gravity: 3.721,
        places: [{ name: "site", kind: "local" }, { name: "mars", kind: "geodetic", datum: "IAU_2015:49900" }],
    },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "box", size: [3.0, 2.7, 1.1], place: { at: [0, 0, 1.0], turn: STILL } }, mass: 1025 },
        // The rocker-bogie: each side's rocker turns on the body, a differential keeping the body level between them.
        { name: "rocker.left", parent: "base", axes: "flu", at: [0, 1.0, 0.8], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-0.45, 0.45] } } },
        { name: "rocker.right", parent: "base", axes: "flu", at: [0, -1.0, 0.8], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-0.45, 0.45] } } },
        ...CORNERS.map((corner): body.Frame => ({
            name: `steer.${corner}`, parent: `rocker.${corner.split(".")[1]}`, axes: "flu", at: [corner.startsWith("front") ? 1.2 : -1.2, 0.1 * side(corner), -0.3], turn: STILL,
            joint: { type: "revolute", axis: [0, 0, 1], limits: { position: [-1.57, 1.57], velocity: 0.1 } },
        })),
        ...WHEELS.map((wheel): body.Frame => ({
            name: `wheel.${wheel}`, parent: wheel.startsWith("middle") ? `rocker.${wheel.split(".")[1]}` : `steer.${wheel}`, axes: "flu",
            at: wheel.startsWith("middle") ? [0.1, 0.1 * side(wheel), -0.45] : [0, 0, -0.15], turn: STILL,
            joint: { type: "continuous", axis: [0, 1, 0], limits: { velocity: 0.8 } }, shape: { kind: "cylinder", radius: 0.26, length: 0.4, place: { at: [0, 0, 0], turn: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } },
        })),
        { name: "mast", parent: "base", axes: "flu", at: [1.0, 0.6, 1.1], turn: STILL, joint: { type: "revolute", axis: [0, 0, 1], limits: { position: [-3.05, 3.05], velocity: 0.2 } } },
        { name: "mast.head", parent: "mast", axes: "flu", at: [0, 0, 1.0], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-1.5, 1.5], velocity: 0.2 } } },
        { name: "navcam.left", parent: "mast.head", axes: "rdf", at: [0.1, 0.212, 0], turn: LOOKING_FORWARD },
        { name: "navcam.right", parent: "mast.head", axes: "rdf", at: [0.1, -0.212, 0], turn: LOOKING_FORWARD },
        // Looking forward and 30° down at the ground ahead: LOOKING_FORWARD, pitched about the base's y.
        { name: "hazcam.front", parent: "base", axes: "rdf", at: [1.5, 0, 0.8], turn: [-(TILT.c + TILT.s) / 2, (TILT.c + TILT.s) / 2, (TILT.s - TILT.c) / 2, (TILT.c - TILT.s) / 2] },
    ],
    senses: [
        { channel: "/imu", kind: "vector", frame: "base", rate: 8, profile: "sensor_msgs/Imu", components: imu([0.002, 0.00005]) },
        {
            channel: "/joints", kind: "vector", rate: 8, profile: "sensor_msgs/JointState",
            components: [
                { name: "rocker.left.position", unit: "rad" }, { name: "rocker.right.position", unit: "rad" },
                ...CORNERS.map(corner => ({ name: `steer.${corner}.position`, unit: "rad" })),
                ...WHEELS.map(wheel => ({ name: `wheel.${wheel}.velocity`, unit: "rad/s" })),
                { name: "mast.position", unit: "rad" }, { name: "mast.head.position", unit: "rad" },
            ],
        },
        {
            channel: "/sun", kind: "vector", frame: "base", rate: 0.1, profile: "axon/sun",
            components: [{ name: "azimuth", unit: "rad", noise: 0.005 }, { name: "elevation", unit: "rad", noise: 0.005 }],
        },
        {
            channel: "/position", kind: "vector", frame: "site", rate: 1, profile: "geometry_msgs/Pose",
            components: [
                { name: "position.x", unit: "m", noise: 0.5 }, { name: "position.y", unit: "m", noise: 0.5 }, { name: "position.z", unit: "m", noise: 0.5 },
                { name: "orientation.x", unit: "1" }, { name: "orientation.y", unit: "1" }, { name: "orientation.z", unit: "1" }, { name: "orientation.w", unit: "1" },
            ],
        },
        { channel: "/navcam.left", kind: "visual", frame: "navcam.left", rate: 0.2, width: 1280, height: 960, lens: NAVCAM, pixel: { kind: "colour" } },
        { channel: "/navcam.right", kind: "visual", frame: "navcam.right", rate: 0.2, width: 1280, height: 960, lens: NAVCAM, pixel: { kind: "colour" } },
        { channel: "/hazcam.front", kind: "visual", frame: "hazcam.front", rate: 1, width: 1280, height: 960, lens: HAZCAM, pixel: { kind: "colour" } },
        {
            channel: "/power", kind: "vector", rate: 0.1, profile: "axon/interoception",
            components: [{ name: "battery", unit: "fraction", range: [0, 1] }, { name: "temperature", unit: "K" }],
        },
    ],
    controls: [
        {
            channel: "/drive", kind: "vector", frame: "base", rate: 8, profile: "geometry_msgs/Twist",
            lapse: { kind: "release", after: 2_000 },
            trajectory: { points: 512, interpolation: "step" },
            components: [
                { name: "linear.x", unit: "m/s", interface: "velocity", range: [-0.042, 0.042], slew: 0.02 },
                { name: "angular.z", unit: "rad/s", interface: "velocity", range: [-0.1, 0.1], slew: 0.05 },
            ],
        },
        {
            channel: "/mast", kind: "vector", rate: 8, lapse: { kind: "keep" },
            trajectory: { points: 32, interpolation: "linear" },
            components: [
                { name: "pan", unit: "rad", interface: "position", joint: "mast", range: [-3.05, 3.05] },
                { name: "tilt", unit: "rad", interface: "position", joint: "mast.head", range: [-1.5, 1.5] },
            ],
        },
    ],
    skills: [
        {
            name: "navigate_to", describe: "Drive itself to a point on the site's map, choosing its own path around the hazards it sees", cancellable: true, within: 14_400_000,
            args: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
            result: { type: "object", properties: { reached: { type: "boolean" }, travelled: { type: "number" }, why: { type: "string" } }, required: ["reached"] },
        },
        {
            name: "panorama", describe: "Take a stereo panorama with the mast's cameras", cancellable: true, within: 3_600_000,
            args: { type: "object", properties: { from: { type: "number" }, to: { type: "number" } }, required: ["from", "to"] },
            result: { type: "object", properties: { images: { type: "integer" } }, required: ["images"] },
        },
        {
            name: "drill", describe: "Drill and keep a core sample where the body stands", cancellable: true, within: 7_200_000,
            args: { type: "object", properties: { depth: { type: "number" } }, required: ["depth"] },
            result: { type: "object", properties: { sample: { type: "string" }, depth: { type: "number" } }, required: ["sample"] },
        },
    ],
}
