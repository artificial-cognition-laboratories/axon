import type { body } from "@arcforge/types"
import { BOOL, LOOKING_FORWARD, REAL, STILL } from "./parts"

/**
 * A house, worn whole through Home Assistant — one body of many parts, not
 * many bodies: rooms are frames of it, every thermometer and light a
 * component. It never moves. It feels warmth and movement in each room and
 * which doors are open, sees its doorstep through a fisheye, hears at the
 * door and speaks there. Its lights, heating and lock stay as last set.
 */
const ROOMS = ["hall", "kitchen", "living", "bedroom"] as const
const AT: Record<(typeof ROOMS)[number], [number, number, number]> = { hall: [0, 0, 0], kitchen: [4, 2, 0], living: [4, -3, 0], bedroom: [2, 0, 2.7] }

export const HOUSE: body.Manifest = {
    contract: "axon.body/1",
    kind: "home-assistant:house",
    clock: { unit: "ms", pace: REAL },
    world: { space: { dimensions: 3 }, gravity: 9.81, anchored: true, places: [] },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "box", size: [10, 8, 5.4], place: { at: [4, 0, 2.7], turn: STILL } } },
        ...ROOMS.map((room): body.Frame => ({ name: room, parent: "base", axes: "flu", at: AT[room], turn: STILL })),
        { name: "doorbell", parent: "hall", axes: "rdf", at: [-0.2, 0.6, 1.5], turn: [-0.5, -0.5, 0.5, 0.5] }, // looking out of the front door, along the hall's −x
    ],
    senses: [
        { channel: "/temperature", kind: "vector", rate: 0.0167, components: ROOMS.map(room => ({ name: room, unit: "K", noise: 0.2 })) },
        { channel: "/motion", kind: "vector", components: ROOMS.map(room => ({ name: room, ...BOOL })) },
        { channel: "/doors", kind: "vector", profile: "axon/contact", components: [{ name: "front", ...BOOL }, { name: "back", ...BOOL }, { name: "garage", ...BOOL }] },
        { channel: "/power", kind: "vector", rate: 0.1, components: [{ name: "draw", unit: "W" }, { name: "solar", unit: "W" }] },
        {
            channel: "/doorstep", kind: "visual", frame: "doorbell", rate: 5, width: 1280, height: 960,
            lens: { kind: "perspective", focal: [380, 380], centre: [640, 480], distortion: { model: "equidistant", coefficients: [0.05, -0.01, 0.002, -0.0003] } },
            pixel: { kind: "colour" },
        },
        { channel: "/door.hearing", kind: "audio", frame: "doorbell", sampleRate: 16_000, channels: 1 },
        {
            channel: "/residents", kind: "text", format: "json",
            schema: { type: "object", properties: { from: { type: "string" }, text: { type: "string" } }, required: ["from", "text"] },
        },
    ],
    controls: [
        { channel: "/lights", kind: "vector", lapse: { kind: "keep" }, components: ROOMS.map(room => ({ name: room, unit: "fraction", interface: "axis" as const, range: [0, 1] as [number, number] })) },
        { channel: "/heating", kind: "vector", lapse: { kind: "keep" }, components: ROOMS.map(room => ({ name: room, unit: "K", interface: "position" as const, range: [283, 297] as [number, number] })) },
        { channel: "/lock", kind: "vector", lapse: { kind: "keep" }, components: [{ name: "front", unit: "category", interface: "choice", categories: ["locked", "unlocked"] }] },
        { channel: "/door.speaker", kind: "audio", sampleRate: 16_000, channels: 1 },
    ],
    skills: [
        {
            name: "notify", describe: "Send a message to the residents' phones", cancellable: false, within: 10_000,
            args: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["text"] },
            result: { type: "object", properties: { delivered: { type: "boolean" } }, required: ["delivered"] },
        },
    ],
}
