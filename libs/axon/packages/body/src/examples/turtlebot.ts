import type { body } from "@arcforge/types"
import { BOOL, COLOUR, imu, LOOKING_FORWARD, pinhole, REAL, STILL } from "./parts"

/**
 * A TurtleBot 4 behind ROS 2: a two-wheeled base, a lidar, a camera. Driven
 * the ROS way, by a velocity for the whole base (`geometry_msgs/Twist`),
 * limited and slewed by the robot; its wheels' joints report where they are.
 * Its map and its odometry are places (REP 105): where navigation is asked to
 * go is on the map.
 */
export const TURTLEBOT = {
    contract: "axon.body/1",
    kind: "ros2:turtlebot4",
    clock: { unit: "ms", pace: REAL },
    world: { space: { dimensions: 3 }, gravity: 9.81, places: [{ name: "map", kind: "local" }, { name: "odom", kind: "local" }] },
    frames: [
        { name: "base", parent: null, axes: "flu", at: [0, 0, 0], turn: STILL, shape: { kind: "cylinder", radius: 0.17, length: 0.34 }, mass: 3.4 },
        { name: "wheel.left", parent: "base", axes: "flu", at: [0, 0.117, 0.036], turn: STILL, joint: { type: "continuous", axis: [0, 1, 0] } },
        { name: "wheel.right", parent: "base", axes: "flu", at: [0, -0.117, 0.036], turn: STILL, joint: { type: "continuous", axis: [0, 1, 0] } },
        { name: "lidar", parent: "base", axes: "flu", at: [0, 0, 0.32], turn: STILL },
        { name: "camera", parent: "base", axes: "rdf", at: [0.06, 0, 0.24], turn: LOOKING_FORWARD },
    ],
    senses: [
        { channel: "/imu", kind: "vector", frame: "base", rate: 62, profile: "sensor_msgs/Imu", components: imu([0.02, 0.002]) },
        {
            channel: "/wheels", kind: "vector", rate: 62, profile: "sensor_msgs/JointState",
            components: [
                { name: "wheel.left.position", unit: "rad" }, { name: "wheel.right.position", unit: "rad" },
                { name: "wheel.left.velocity", unit: "rad/s" }, { name: "wheel.right.velocity", unit: "rad/s" },
            ],
        },
        {
            channel: "/odom", kind: "vector", frame: "odom", rate: 62, profile: "nav_msgs/Odometry",
            components: [{ name: "position.x", unit: "m" }, { name: "position.y", unit: "m" }, { name: "yaw", unit: "rad" }],
        },
        {
            channel: "/scan", kind: "visual", frame: "lidar", rate: 5, width: 1440, height: 1, profile: "sensor_msgs/LaserScan",
            lens: { kind: "polar", from: -Math.PI, to: Math.PI, elevation: [0] }, pixel: { kind: "depth", range: 12 },
        },
        { channel: "/camera", kind: "visual", frame: "camera", rate: 15, width: 640, height: 480, lens: pinhole(640, 480, 0.96), pixel: COLOUR, profile: "sensor_msgs/Image" },
        {
            channel: "/bumper", kind: "vector", frame: "base", rate: 62, profile: "axon/contact",
            components: [{ name: "front.left", ...BOOL }, { name: "front.center", ...BOOL }, { name: "front.right", ...BOOL }],
        },
    ],
    controls: [
        {
            channel: "/cmd_vel", kind: "vector", frame: "base", lapse: { kind: "release", after: 500 }, rate: 20, profile: "geometry_msgs/Twist",
            components: [
                { name: "linear.x", unit: "m/s", interface: "velocity", range: [-0.31, 0.31], slew: 1 },
                { name: "angular.z", unit: "rad/s", interface: "velocity", range: [-1.9, 1.9], slew: 4 },
            ],
        },
    ],
    skills: [
        {
            name: "navigate_to", describe: "Drive to a pose on the map, avoiding what the lidar sees", cancellable: true, within: 300_000,
            args: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, yaw: { type: "number" } }, required: ["x", "y"] },
            result: { type: "object", properties: { reached: { type: "boolean" }, error: { type: "string" } } },
        },
        {
            name: "dock", describe: "Return to the charging dock", cancellable: true, within: 120_000,
            args: { type: "object", properties: {} },
            result: { type: "object", properties: { docked: { type: "boolean" } } },
        },
    ],
} as const satisfies body.Manifest
