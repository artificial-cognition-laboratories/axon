import type { body } from "@arcforge/types"
import { COLOUR, LOOKING_SIDEWAYS, REAL, STILL, SWITCH } from "./parts"

/**
 * Terraria, as AxonT describes it: a world of two dimensions, seen side-on.
 * The base's forward is the screen's right and its up the screen's up; the
 * camera looks into the screen along the body's left through an orthographic
 * lens — a pixel is a sixteenth of a tile, so 1/16 m — from the picture's
 * top-left. Its inner ear has two axes; it has no depth camera and no touch.
 * Gravity is 0.4 px a tick², 90 m/s². Speaking, PvP, teams and the held slot
 * are skills.
 */
export const TERRARIA = {
    contract: "axon.body/1",
    kind: "terraria.player",
    clock: { unit: "ms", step: 1000 / 60, pace: REAL },
    world: { space: { dimensions: 2, plane: "xz" }, gravity: 90, places: [] },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "box", size: [1.25, 1.25, 2.625] } },
        { name: "eye", parent: "base", axes: "rdf", at: [-40, 0, 22.5], turn: LOOKING_SIDEWAYS },
    ],
    senses: [
        {
            channel: "/imu", kind: "vector", frame: "base", rate: 60, profile: "axon/imu2d",
            components: [{ name: "accel.x", unit: "m/s²", noise: 11.25 }, { name: "accel.z", unit: "m/s²", noise: 11.25 }],
        },
        {
            channel: "/interoception", kind: "vector", rate: 20, profile: "axon/interoception",
            components: [
                { name: "pain", unit: "fraction" }, { name: "weakness", unit: "fraction" },
                { name: "hunger", unit: "fraction" }, { name: "thirst", unit: "fraction" }, { name: "stamina", unit: "fraction" },
                { name: "breath", unit: "fraction" }, { name: "mana", unit: "fraction" },
                { name: "respawned", unit: "count" },
            ],
        },
        { channel: "/vision", kind: "visual", frame: "eye", rate: 24, width: 1280, height: 720, lens: { kind: "orthographic", scale: 1 / 16 }, pixel: COLOUR },
        { channel: "/hearing", kind: "audio", sampleRate: 22_050, channels: 2 },
    ],
    controls: [
        {
            channel: "/legs", kind: "vector", frame: "base", lapse: { kind: "release", after: 150 }, rate: 60,
            components: [
                { name: "left", ...SWITCH }, { name: "right", ...SWITCH }, { name: "up", ...SWITCH }, { name: "down", ...SWITCH },
                { name: "jump", ...SWITCH },
            ],
        },
        { channel: "/hands", kind: "vector", lapse: { kind: "release", after: 150 }, rate: 60, components: [{ name: "use.item", ...SWITCH }, { name: "use.tile", ...SWITCH }] },
    ],
    skills: [
        {
            name: "say", describe: "Say something in the world's chat, as this body", cancellable: false, within: 5_000,
            args: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            result: { type: "object", properties: { said: { type: "string" } }, required: ["said"] },
        },
        {
            name: "select-slot", describe: "Choose which hotbar slot, 0 to 9, the hands hold — what using an item uses", cancellable: false, within: 5_000,
            args: { type: "object", properties: { slot: { type: "integer" } }, required: ["slot"] },
            result: { type: "object", properties: { slot: { type: "integer" } }, required: ["slot"] },
        },
    ],
} as const satisfies body.Manifest
