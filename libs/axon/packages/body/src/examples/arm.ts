import type { body } from "@arcforge/types"
import { LOOKING_FORWARD, rpy, STILL } from "./parts"

/**
 * A Franka Panda arm, bolted to a bench: seven joints and a two-finger
 * gripper whose second finger mirrors the first. Its skeleton is the one in
 * Franka's URDF (`tests/fixtures/robots/franka-panda.urdf`).
 *
 * An arm is driven to positions, and they are safe left applied: if its mind
 * goes, it holds where it was told. It takes whole trajectories, which its
 * own controllers follow a thousand times a second — no mind closes that loop
 * over a socket. A wrist camera sees colour and depth; a sensor at the wrist
 * feels force.
 */
const HALF = Math.PI / 2
/** Each joint: where it sits on the link before it, how that link is turned, its limits (rad, rad/s, N·m). */
const JOINTS: { at: [number, number, number]; turn: [number, number, number]; position: [number, number]; velocity: number; effort: number }[] = [
    { at: [0, 0, 0.333], turn: [0, 0, 0], position: [-2.9671, 2.9671], velocity: 2.175, effort: 87 },
    { at: [0, 0, 0], turn: [-HALF, 0, 0], position: [-1.8326, 1.8326], velocity: 2.175, effort: 87 },
    { at: [0, -0.316, 0], turn: [HALF, 0, 0], position: [-2.9671, 2.9671], velocity: 2.175, effort: 87 },
    { at: [0.0825, 0, 0], turn: [HALF, 0, 0], position: [-3.1416, 0], velocity: 2.175, effort: 87 },
    { at: [-0.0825, 0.384, 0], turn: [-HALF, 0, 0], position: [-2.9671, 2.9671], velocity: 2.61, effort: 12 },
    { at: [0, 0, 0], turn: [HALF, 0, 0], position: [-0.0873, 3.8223], velocity: 2.61, effort: 12 },
    { at: [0.088, 0, 0], turn: [HALF, 0, 0], position: [-2.9671, 2.9671], velocity: 2.61, effort: 12 },
]
const LINKS = JOINTS.map((_, index) => `panda_link${index + 1}`)

export const ARM: body.Manifest = {
    contract: "axon.body/1",
    kind: "franka:panda",
    clock: { unit: "ms", step: 1, pace: { kind: "real" } },
    world: { space: { dimensions: 3 }, gravity: 9.81, anchored: true, places: [] },
    frames: [
        { name: "panda_link0", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, mass: 2.9 },
        ...JOINTS.map((joint, index): body.Frame => ({
            name: LINKS[index]!, parent: index === 0 ? "panda_link0" : LINKS[index - 1]!, axes: "flu", at: joint.at, turn: rpy(...joint.turn),
            joint: { name: `panda_joint${index + 1}`, type: "revolute", axis: [0, 0, 1], limits: { position: joint.position, velocity: joint.velocity, effort: joint.effort } },
        })),
        { name: "panda_link8", parent: "panda_link7", axes: "flu", at: [0, 0, 0.107], turn: STILL },
        { name: "panda_hand", parent: "panda_link8", axes: "flu", at: [0, 0, 0], turn: rpy(0, 0, -Math.PI / 4), mass: 0.73 },
        {
            name: "panda_leftfinger", parent: "panda_hand", axes: "flu", at: [0, 0, 0.0584], turn: STILL,
            joint: { name: "panda_finger_joint1", type: "prismatic", axis: [0, 1, 0], limits: { position: [0, 0.04], velocity: 0.2, effort: 20 } },
        },
        {
            name: "panda_rightfinger", parent: "panda_hand", axes: "flu", at: [0, 0, 0.0584], turn: STILL,
            joint: { name: "panda_finger_joint2", type: "prismatic", axis: [0, -1, 0], limits: { position: [0, 0.04], velocity: 0.2, effort: 20 }, mimic: { joint: "panda_leftfinger", multiplier: 1, offset: 0 } },
        },
        { name: "wrist_camera_optical_frame", parent: "panda_hand", axes: "rdf", at: [0.05, 0, 0.04], turn: LOOKING_FORWARD },
    ],
    senses: [
        {
            channel: "/joints", kind: "vector", rate: 1000, profile: "sensor_msgs/JointState",
            components: LINKS.flatMap((_, index) => [`panda_joint${index + 1}`]).concat("panda_finger_joint1")
                .flatMap(joint => [{ name: `${joint}.position`, unit: joint.includes("finger") ? "m" : "rad" }, { name: `${joint}.effort`, unit: joint.includes("finger") ? "N" : "N·m" }]),
        },
        {
            channel: "/wrench", kind: "vector", frame: "panda_hand", rate: 1000, profile: "geometry_msgs/Wrench",
            components: [
                ...["x", "y", "z"].map(axis => ({ name: `force.${axis}`, unit: "N", noise: 0.5 })),
                ...["x", "y", "z"].map(axis => ({ name: `torque.${axis}`, unit: "N·m", noise: 0.05 })),
            ],
        },
        {
            channel: "/wrist", kind: "visual", frame: "wrist_camera_optical_frame", rate: 30, width: 848, height: 480, profile: "sensor_msgs/Image",
            lens: { kind: "perspective", focal: [425.1, 424.6], centre: [422.3, 241.8], distortion: { model: "plumb_bob", coefficients: [-0.055, 0.064, -0.0003, 0.0007, -0.021] } },
            pixel: { kind: "colour" },
        },
        {
            channel: "/wrist.depth", kind: "visual", frame: "wrist_camera_optical_frame", rate: 30, width: 848, height: 480, profile: "sensor_msgs/Image",
            lens: { kind: "perspective", focal: [425.1, 424.6], centre: [422.3, 241.8] },
            pixel: { kind: "depth", range: 0.5 },
        },
    ],
    controls: [
        {
            channel: "/arm", kind: "vector", rate: 1000, profile: "trajectory_msgs/JointTrajectory",
            lapse: { kind: "keep" },
            trajectory: { points: 256, interpolation: "linear" },
            components: JOINTS.map((joint, index) => ({ name: `panda_joint${index + 1}`, unit: "rad", interface: "position" as const, joint: LINKS[index]!, range: joint.position, slew: joint.velocity })),
        },
        {
            channel: "/gripper", kind: "vector", rate: 100, lapse: { kind: "keep" },
            components: [{ name: "width", unit: "m", interface: "position", joint: "panda_leftfinger", range: [0, 0.04] }],
        },
    ],
    skills: [
        {
            name: "grasp", describe: "Close the fingers on what is between them, with a force, and say whether it is held", cancellable: false, within: 5_000,
            args: { type: "object", properties: { force: { type: "number" } }, required: ["force"] },
            result: { type: "object", properties: { held: { type: "boolean" }, width: { type: "number" } }, required: ["held"] },
        },
    ],
}
