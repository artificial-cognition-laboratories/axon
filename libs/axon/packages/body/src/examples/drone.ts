import type { body } from "@arcforge/types"
import { COLOUR, imu, LOOKING_FORWARD, pinhole, REAL, STILL } from "./parts"

/**
 * A quadrotor behind PX4, flown offboard. Letting go of a drone drops it, so
 * its velocity control does not release: after half a second without a
 * command the autopilot takes over — holds where it is, then lands. Its
 * velocity is given over the ground, in the home place's axes; where it is
 * comes from GNSS, in the planet's. What the autopilot is doing is a choice
 * among its modes.
 */
const MODES = ["manual", "position", "offboard", "mission", "return", "land"]

export const DRONE: body.Manifest = {
    contract: "axon.body/1",
    kind: "px4:quadrotor",
    clock: { unit: "ms", pace: REAL },
    world: { space: { dimensions: 3 }, gravity: 9.81, places: [{ name: "earth", kind: "geodetic", datum: "WGS84" }, { name: "home", kind: "local" }] },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "box", size: [0.45, 0.45, 0.12] }, mass: 1.5, inertia: [0.029, 0, 0, 0.029, 0, 0.055] },
        ...[[0.16, 0.16], [-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16]].map(([x, y], index): body.Frame => ({
            name: `rotor.${index}`, parent: "base", axes: "flu", at: [x!, y!, 0.04], turn: STILL, joint: { type: "continuous", axis: [0, 0, index < 2 ? 1 : -1] },
            shape: { kind: "cylinder", radius: 0.12, length: 0.01 },
        })),
        { name: "gimbal", parent: "base", axes: "flu", at: [0.12, 0, -0.06], turn: STILL, joint: { type: "revolute", axis: [0, 1, 0], limits: { position: [0, Math.PI / 2], velocity: 1 } } },
        { name: "camera", parent: "gimbal", axes: "rdf", at: [0.02, 0, 0], turn: LOOKING_FORWARD },
        { name: "rangefinder", parent: "base", axes: "flu", at: [0, 0, -0.06], turn: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
    ],
    senses: [
        { channel: "/imu", kind: "vector", frame: "base", rate: 250, profile: "sensor_msgs/Imu", components: imu([0.03, 0.003]) },
        {
            channel: "/gnss", kind: "vector", frame: "earth", rate: 5, profile: "sensor_msgs/NavSatFix",
            components: [{ name: "latitude", unit: "rad", noise: 4e-7 }, { name: "longitude", unit: "rad", noise: 4e-7 }, { name: "altitude", unit: "m", noise: 4 }],
        },
        { channel: "/magnetometer", kind: "vector", frame: "base", rate: 100, profile: "sensor_msgs/MagneticField", components: ["x", "y", "z"].map(axis => ({ name: `field.${axis}`, unit: "T", noise: 1e-7 })) },
        { channel: "/barometer", kind: "vector", rate: 50, profile: "sensor_msgs/FluidPressure", components: [{ name: "pressure", unit: "Pa", noise: 2 }] },
        { channel: "/range", kind: "vector", frame: "rangefinder", rate: 50, profile: "sensor_msgs/Range", components: [{ name: "range", unit: "m", range: [0.1, 12], noise: 0.02 }] },
        { channel: "/autopilot", kind: "vector", rate: 2, profile: "px4/vehicle_status", components: [{ name: "mode", unit: "category", categories: MODES }, { name: "armed", unit: "bool" }] },
        { channel: "/battery", kind: "vector", rate: 1, profile: "axon/interoception", components: [{ name: "charge", unit: "fraction", range: [0, 1] }, { name: "voltage", unit: "V" }] },
        { channel: "/camera", kind: "visual", frame: "camera", rate: 30, width: 1920, height: 1080, lens: pinhole(1920, 1080, 1.0), pixel: COLOUR },
    ],
    controls: [
        {
            channel: "/velocity", kind: "vector", frame: "home", rate: 50, profile: "px4/trajectory_setpoint",
            lapse: { kind: "behaviour", after: 500, name: "hold-then-land", describe: "Holds where it is for five seconds, then lands there" },
            components: [
                { name: "x", unit: "m/s", interface: "velocity", range: [-12, 12], slew: 4 },
                { name: "y", unit: "m/s", interface: "velocity", range: [-12, 12], slew: 4 },
                { name: "z", unit: "m/s", interface: "velocity", range: [-3, 5], slew: 3 },
                { name: "yaw", unit: "rad/s", interface: "velocity", range: [-1.5, 1.5] },
            ],
        },
        { channel: "/gimbal", kind: "vector", rate: 20, lapse: { kind: "keep" }, components: [{ name: "pitch", unit: "rad", interface: "position", joint: "gimbal", range: [0, Math.PI / 2] }] },
    ],
    skills: [
        {
            name: "takeoff", describe: "Arm, climb to a height above home, and hold there", cancellable: true, within: 60_000,
            args: { type: "object", properties: { height: { type: "number" } }, required: ["height"] },
            result: { type: "object", properties: { height: { type: "number" } }, required: ["height"] },
        },
        {
            name: "land", describe: "Descend and land where it is, then disarm", cancellable: true, within: 120_000,
            args: { type: "object", properties: {} },
            result: { type: "object", properties: { landed: { type: "boolean" } }, required: ["landed"] },
        },
        {
            name: "return", describe: "Fly home at a safe height and land there", cancellable: true, within: 900_000,
            args: { type: "object", properties: {} },
            result: { type: "object", properties: { landed: { type: "boolean" } }, required: ["landed"] },
        },
    ],
}
