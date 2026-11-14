import type { body } from "@arcforge/types"
import { COLOUR, imu, LOOKING_FORWARD, REAL, STILL } from "./parts"

/**
 * A road car under Autoware, with a safety driver. Steered by the front
 * wheels — the right one following the left — driven by pedals, put in gear
 * by choice. Left alone it brakes to a stop. When the safety driver takes the
 * wheel, the body is `overridden`: it still senses, and applies nothing.
 *
 * A 32-beam lidar on the roof — its beams at uneven elevations, packed tight
 * near the horizon — a front camera with a wide, distorted lens, GNSS, and a
 * radar that reports however many things it tracks.
 */
/** The lidar's beam elevations, top first, rad: a VLP-32C's. */
const BEAMS = [15, 10.333, 7, 4.667, 3.333, 2.333, 1.667, 1.333, 1, 0.667, 0.333, 0, -0.333, -0.667, -1, -1.333, -1.667, -2, -2.333, -2.667, -3, -3.333, -3.667, -4, -4.667, -5.333, -6.148, -7.254, -8.843, -11.31, -15.639, -25]
    .map(degrees => degrees * Math.PI / 180)
const GEARS = ["park", "reverse", "neutral", "drive"]

export const CAR: body.Manifest = {
    contract: "axon.body/1",
    kind: "autoware:car",
    clock: { unit: "ms", pace: REAL },
    world: { space: { dimensions: 3 }, gravity: 9.81, places: [{ name: "earth", kind: "geodetic", datum: "WGS84" }, { name: "map", kind: "local" }] },
    frames: [
        // The base is the rear axle's middle, on the ground, as ROS cars have it.
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "box", size: [4.7, 1.9, 1.5], place: { at: [1.4, 0, 0.75], turn: STILL } }, mass: 1650 },
        { name: "steer.left", parent: "base", axes: "flu", at: [2.8, 0.8, 0.33], turn: STILL, joint: { type: "revolute", axis: [0, 0, 1], limits: { position: [-0.6, 0.6], velocity: 0.8 } } },
        { name: "steer.right", parent: "base", axes: "flu", at: [2.8, -0.8, 0.33], turn: STILL, joint: { type: "revolute", axis: [0, 0, 1], limits: { position: [-0.6, 0.6] }, mimic: { joint: "steer.left", multiplier: 1, offset: 0 } } },
        { name: "lidar", parent: "base", axes: "flu", at: [1.2, 0, 1.9], turn: STILL },
        { name: "camera", parent: "base", axes: "rdf", at: [2.0, 0, 1.4], turn: LOOKING_FORWARD },
        { name: "radar", parent: "base", axes: "flu", at: [3.9, 0, 0.5], turn: STILL },
        { name: "gnss", parent: "base", axes: "flu", at: [0.5, 0, 1.6], turn: STILL },
    ],
    senses: [
        { channel: "/imu", kind: "vector", frame: "base", rate: 100, profile: "sensor_msgs/Imu", components: imu([0.05, 0.002]) },
        {
            channel: "/gnss", kind: "vector", frame: "earth", rate: 10, profile: "sensor_msgs/NavSatFix",
            components: [{ name: "latitude", unit: "rad", noise: 3e-7 }, { name: "longitude", unit: "rad", noise: 3e-7 }, { name: "altitude", unit: "m", noise: 3 }],
        },
        { channel: "/speed", kind: "vector", frame: "base", rate: 50, profile: "autoware/velocity_report", components: [{ name: "longitudinal", unit: "m/s" }, { name: "steering", unit: "rad" }] },
        { channel: "/gear", kind: "vector", rate: 10, components: [{ name: "gear", unit: "category", categories: GEARS }] },
        {
            channel: "/lidar", kind: "visual", frame: "lidar", rate: 10, width: 1800, height: BEAMS.length, profile: "sensor_msgs/PointCloud2",
            lens: { kind: "polar", from: -Math.PI, to: Math.PI, elevation: BEAMS }, pixel: { kind: "depth", range: 200 },
        },
        {
            channel: "/camera", kind: "visual", frame: "camera", rate: 30, width: 1920, height: 1080, profile: "sensor_msgs/Image",
            lens: { kind: "perspective", focal: [1040, 1040], centre: [960, 540], distortion: { model: "rational_polynomial", coefficients: [-0.31, 0.11, 0.0001, 0.0002, -0.017, 0.02, 0.01, -0.005] } },
            pixel: COLOUR,
        },
        {
            channel: "/radar", kind: "text", frame: "radar", rate: 20, format: "json", profile: "radar_msgs/RadarTracks",
            schema: {
                type: "array",
                items: { type: "object", properties: { range: { type: "number" }, bearing: { type: "number" }, closing: { type: "number" } }, required: ["range", "bearing", "closing"] },
            },
        },
    ],
    controls: [
        {
            channel: "/drive", kind: "vector", frame: "base", rate: 50,
            lapse: { kind: "behaviour", after: 200, name: "stop", describe: "Brakes to a standstill in its lane and holds the brake" },
            components: [
                { name: "steering", unit: "rad", interface: "position", joint: "steer.left", range: [-0.6, 0.6], slew: 0.5 },
                { name: "throttle", unit: "fraction", interface: "axis", range: [0, 1], slew: 2 },
                { name: "brake", unit: "fraction", interface: "axis", range: [0, 1] },
            ],
        },
        { channel: "/gear", kind: "vector", rate: 10, lapse: { kind: "keep" }, components: [{ name: "gear", unit: "category", interface: "choice", categories: GEARS }] },
    ],
    skills: [
        {
            name: "route_to", describe: "Drive itself along the road network to a point on the map", cancellable: true, within: 3_600_000,
            args: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
            result: { type: "object", properties: { arrived: { type: "boolean" }, why: { type: "string" } }, required: ["arrived"] },
        },
    ],
}
