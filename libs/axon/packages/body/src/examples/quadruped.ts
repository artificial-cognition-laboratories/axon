import type { body } from "@arcforge/types"
import { BOOL, COLOUR, imu, LOOKING_FORWARD, pinhole, STILL } from "./parts"

/**
 * A quadruped in a simulator run at real speed — twelve joints, three a leg:
 * a hip that swings out, a hip that swings forward, a knee. Every joint
 * reports where it is and is driven to a position, within its limits, by the
 * body's own joint controllers; if the mind goes quiet, the joints go limp.
 */
const LEGS = ["front.left", "front.right", "hind.left", "hind.right"] as const
const HIPS: Record<(typeof LEGS)[number], [number, number, number]> = {
    "front.left": [0.19, 0.05, 0], "front.right": [0.19, -0.05, 0], "hind.left": [-0.19, 0.05, 0], "hind.right": [-0.19, -0.05, 0],
}
const JOINTS = LEGS.flatMap(leg => [`${leg}.abduct`, `${leg}.hip`, `${leg}.knee`])

export const QUADRUPED: body.Manifest = {
    contract: "axon.body/1",
    kind: "sim:quadruped",
    clock: { unit: "ms", step: 2, pace: { kind: "scaled", factor: 1 } },
    world: { space: { dimensions: 3 }, gravity: 9.81, places: [] },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "box", size: [0.38, 0.19, 0.11] }, mass: 6 },
        ...LEGS.flatMap((leg): body.Frame[] => [
            { name: `${leg}.abduct`, parent: "base", axes: "flu", at: HIPS[leg], turn: STILL, joint: { type: "revolute", axis: [1, 0, 0], limits: { position: [-0.8, 0.8], velocity: 21, effort: 23.7 } }, mass: 0.7 },
            { name: `${leg}.hip`, parent: `${leg}.abduct`, axes: "flu", at: [0, 0, 0], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-1, 3.5], velocity: 21, effort: 23.7 } }, shape: { kind: "box", size: [0.04, 0.03, 0.21] }, mass: 1 },
            { name: `${leg}.knee`, parent: `${leg}.hip`, axes: "flu", at: [0, 0, -0.21], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-2.7, -0.9], velocity: 21, effort: 35.5 } }, shape: { kind: "box", size: [0.02, 0.02, 0.21] }, mass: 0.2 },
        ]),
        { name: "camera", parent: "base", axes: "rdf", at: [0.2, 0, 0.05], turn: LOOKING_FORWARD },
    ],
    senses: [
        { channel: "/imu", kind: "vector", frame: "base", rate: 500, profile: "sensor_msgs/Imu", components: imu([0.05, 0.005]) },
        {
            channel: "/joints", kind: "vector", rate: 500, profile: "sensor_msgs/JointState",
            components: JOINTS.flatMap(joint => [{ name: `${joint}.position`, unit: "rad" }, { name: `${joint}.velocity`, unit: "rad/s" }, { name: `${joint}.effort`, unit: "N·m" }]),
        },
        { channel: "/feet", kind: "vector", rate: 500, profile: "axon/contact", components: LEGS.map(leg => ({ name: leg, ...BOOL })) },
        { channel: "/camera", kind: "visual", frame: "camera", rate: 30, width: 640, height: 480, lens: pinhole(640, 480, 1.0), pixel: COLOUR },
    ],
    controls: [
        {
            channel: "/joints", kind: "vector", lapse: { kind: "release", after: 20 }, rate: 500, profile: "trajectory_msgs/JointTrajectoryPoint",
            components: JOINTS.map(joint => ({ name: joint, unit: "rad", interface: "position", joint: joint })),
        },
    ],
    skills: [],
}
