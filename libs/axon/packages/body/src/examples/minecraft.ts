import type { body } from "@arcforge/types"
import { BOOL, COLOUR, LOOKING_FORWARD, pinhole, REAL, STILL, SWITCH } from "./parts"

/**
 * Minecraft, as AxonM describes it — and the chat it does not have yet,
 * heard with who said it and said back. The look is two joints — a yaw
 * without end at the neck, a pitch at the head — driven at a velocity, at
 * most half a turn a second. No sense reports where they are: the mind knows
 * its look by its inner ear and what it sent. Gravity is 0.08 blocks a tick²,
 * 32 m/s².
 */
export const MINECRAFT = {
    contract: "axon.body/1",
    kind: "minecraft.player",
    clock: { unit: "ms", step: 50, pace: REAL },
    world: { space: { dimensions: 3 }, gravity: 32, places: [] },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "box", size: [0.6, 0.6, 1.8], place: { at: [0, 0, 0.9], turn: STILL } } },
        { name: "neck", parent: "base", axes: "flu", at: [0, 0, 1.62], turn: STILL, joint: { type: "continuous", axis: [0, 0, 1] } },
        { name: "head", parent: "neck", axes: "flu", at: [0, 0, 0], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [-Math.PI / 2, Math.PI / 2] } } },
        { name: "eye", parent: "head", axes: "rdf", at: [0, 0, 0], turn: LOOKING_FORWARD },
    ],
    senses: [
        {
            channel: "/imu", kind: "vector", frame: "head", rate: 20, profile: "sensor_msgs/Imu",
            components: [
                { name: "accel.x", unit: "m/s²" }, { name: "accel.y", unit: "m/s²" }, { name: "accel.z", unit: "m/s²" },
                { name: "gyro.x", unit: "rad/s" }, { name: "gyro.y", unit: "rad/s" }, { name: "gyro.z", unit: "rad/s" },
            ],
        },
        {
            channel: "/contact", kind: "vector", frame: "base", rate: 20, profile: "axon/contact",
            components: [{ name: "ground", ...BOOL }, { name: "horizontal", ...BOOL }, { name: "submerged", ...BOOL }],
        },
        {
            channel: "/posture", kind: "vector", rate: 20, profile: "axon/posture",
            components: [{ name: "crouch", ...BOOL }, { name: "sprint", ...BOOL }, { name: "swim", ...BOOL }],
        },
        {
            channel: "/interoception", kind: "vector", rate: 20, profile: "axon/interoception",
            components: [
                { name: "pain", unit: "fraction", range: [0, 1] }, { name: "pain.direction", unit: "rad" },
                { name: "weakness", unit: "fraction", range: [0, 1] }, { name: "hunger", unit: "fraction", range: [0, 1] },
                { name: "breath", unit: "fraction", range: [0, 1] }, { name: "burning", ...BOOL }, { name: "wet", ...BOOL },
                { name: "respawned", unit: "count" },
            ],
        },
        { channel: "/vision", kind: "visual", frame: "eye", rate: 20, width: 1280, height: 720, lens: pinhole(1280, 720, 1.22), pixel: COLOUR },
        { channel: "/depth", kind: "visual", frame: "eye", rate: 20, width: 160, height: 90, lens: pinhole(160, 90, 1.22), pixel: { kind: "depth", range: 64 } },
        { channel: "/hearing", kind: "audio", sampleRate: 44_100, channels: 2 },
        {
            channel: "/chat", kind: "text", format: "json",
            schema: { type: "object", properties: { from: { type: "string" }, text: { type: "string" } }, required: ["from", "text"] },
        },
    ],
    controls: [
        {
            channel: "/legs", kind: "vector", frame: "base", lapse: { kind: "release", after: 150 }, rate: 20,
            components: [
                { name: "forward", ...SWITCH }, { name: "back", ...SWITCH }, { name: "left", ...SWITCH }, { name: "right", ...SWITCH },
                { name: "jump", ...SWITCH }, { name: "sneak", ...SWITCH }, { name: "sprint", ...SWITCH },
            ],
        },
        { channel: "/hands", kind: "vector", lapse: { kind: "release", after: 150 }, rate: 20, components: [{ name: "attack", ...SWITCH }, { name: "use", ...SWITCH }] },
        {
            channel: "/look", kind: "vector", lapse: { kind: "release", after: 150 }, rate: 20,
            components: [
                { name: "yaw", unit: "rad/s", interface: "velocity", joint: "neck", range: [-Math.PI, Math.PI] },
                { name: "pitch", unit: "rad/s", interface: "velocity", joint: "head", range: [-Math.PI, Math.PI] },
            ],
        },
        { channel: "/say", kind: "text" },
    ],
    skills: [],
} as const satisfies body.Manifest
