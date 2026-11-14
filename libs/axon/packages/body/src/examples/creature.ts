import type { body } from "@arcforge/types"
import { BOOL, COLOUR, imu, LOOKING_FORWARD, pinhole, STILL } from "./parts"

/**
 * A creature in a physics simulation that waits for its mind: the world
 * moves only when told to, ten milliseconds a step, so a slow mind is never
 * a clumsy body — what training and evolving a body needs. Four legs of two
 * joints driven by force, two eyes, a sense of smell, and a lateral line
 * telling it what moves near it, however many things that is.
 */
const LEGS = ["front.left", "front.right", "hind.left", "hind.right"] as const
const ODOURS = ["food", "water", "kin", "predator"]

export const CREATURE: body.Manifest = {
    contract: "axon.body/1",
    kind: "sim:creature",
    clock: { unit: "ms", step: 10, pace: { kind: "stepped" } },
    world: { space: { dimensions: 3 }, gravity: 9.81, places: [] },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "sphere", radius: 0.25 }, mass: 8 },
        ...LEGS.flatMap((leg): body.Frame[] => {
            const [x, y] = [leg.startsWith("front") ? 0.2 : -0.2, leg.endsWith("left") ? 0.15 : -0.15]
            return [
                { name: `${leg}.hip`, parent: "base", axes: "flu", at: [x, y, -0.1], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-1.2, 1.2], effort: 40 } }, shape: { kind: "cylinder", radius: 0.04, length: 0.3, place: { at: [0, 0, -0.15], turn: STILL } }, mass: 0.6 },
                { name: `${leg}.knee`, parent: `${leg}.hip`, axes: "flu", at: [0, 0, -0.3], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-2.4, 0], effort: 30 } }, shape: { kind: "cylinder", radius: 0.03, length: 0.3, place: { at: [0, 0, -0.15], turn: STILL } }, mass: 0.3 },
            ]
        }),
        { name: "eye.left", parent: "base", axes: "rdf", at: [0.22, 0.06, 0.1], turn: LOOKING_FORWARD },
        { name: "eye.right", parent: "base", axes: "rdf", at: [0.22, -0.06, 0.1], turn: LOOKING_FORWARD },
    ],
    senses: [
        { channel: "/balance", kind: "vector", frame: "base", rate: 100, profile: "sensor_msgs/Imu", components: imu([0.1, 0.01]) },
        {
            channel: "/joints", kind: "vector", rate: 100, profile: "sensor_msgs/JointState",
            components: LEGS.flatMap(leg => [`${leg}.hip`, `${leg}.knee`]).flatMap(joint => [{ name: `${joint}.position`, unit: "rad" }, { name: `${joint}.velocity`, unit: "rad/s" }]),
        },
        { channel: "/feet", kind: "vector", rate: 100, profile: "axon/contact", components: LEGS.map(leg => ({ name: leg, ...BOOL })) },
        { channel: "/eye.left", kind: "visual", frame: "eye.left", rate: 20, width: 64, height: 64, lens: pinhole(64, 64, 2.0), pixel: COLOUR },
        { channel: "/eye.right", kind: "visual", frame: "eye.right", rate: 20, width: 64, height: 64, lens: pinhole(64, 64, 2.0), pixel: COLOUR },
        { channel: "/smell", kind: "vector", rate: 10, profile: "axon/smell", components: ODOURS.map(odour => ({ name: odour, unit: "fraction", range: [0, 1] as [number, number] })) },
        {
            channel: "/lateral", kind: "text", frame: "base", rate: 10, format: "json",
            schema: {
                type: "array",
                items: { type: "object", properties: { bearing: { type: "number" }, distance: { type: "number" }, size: { type: "number" } }, required: ["bearing", "distance", "size"] },
            },
        },
        { channel: "/energy", kind: "vector", rate: 10, profile: "axon/interoception", components: [{ name: "energy", unit: "fraction", range: [0, 1] }, { name: "pain", unit: "fraction", range: [0, 1] }] },
    ],
    controls: [
        {
            channel: "/muscles", kind: "vector", rate: 100, lapse: { kind: "release", after: 30 },
            components: LEGS.flatMap(leg => [`${leg}.hip`, `${leg}.knee`]).map(joint => ({ name: joint, unit: "N·m", interface: "effort" as const, joint: joint, range: [-30, 30] as [number, number] })),
        },
    ],
    skills: [],
}
