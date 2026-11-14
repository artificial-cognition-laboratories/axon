import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import type { body } from "@arcforge/types"
import { examples, manifest, urdf, type Skeleton } from "../../src"

const RELEASE: body.Lapse = { kind: "release", after: 100 }
const robot = (file: string) => readFileSync(new URL(`../fixtures/robots/${file}`, import.meta.url), "utf8")

/** The same rotation: q and −q are one turn. */
function sameTurn(a: number[], b: number[]): boolean {
    return Math.abs(Math.abs(a.reduce((sum, value, index) => sum + value * b[index]!, 0)) - 1) < 1e-9
}

function near(a: unknown, b: unknown, path: string): void {
    if (typeof a === "number" && typeof b === "number") return void expect(Math.abs(a - b), path).toBeLessThan(1e-9)
    if (Array.isArray(a) && Array.isArray(b)) { expect(a.length, path).toBe(b.length); a.forEach((value, index) => near(value, b[index], `${path}[${index}]`)); return }
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
        expect(Object.keys(a).sort(), path).toEqual(Object.keys(b).sort())
        for (const key of Object.keys(a)) {
            const [left, right] = [(a as any)[key], (b as any)[key]]
            if (key === "turn") expect(sameTurn(left, right), `${path}.turn`).toBe(true)
            else near(left, right, `${path}.${key}`)
        }
        return
    }
    expect(a, path).toEqual(b)
}

/** What URDF keeps of a frame: a fixed frame's axes are `flu` unless named an optical frame, so compare those apart. */
function skeletal(frames: readonly body.Frame[]): body.Frame[] {
    return frames.map(frame => ({ ...frame, axes: "flu" }))
}

/** A skeleton as a whole body, for the contract to check. */
function worn(skeleton: Skeleton): body.Manifest {
    return {
        contract: "axon.body/1", kind: `urdf:${skeleton.name}`, clock: { unit: "ms", pace: { kind: "real" } },
        world: { space: { dimensions: 3 }, gravity: 9.81, anchored: skeleton.anchored, places: skeleton.places },
        frames: skeleton.frames, senses: skeleton.senses, controls: skeleton.controls, skills: [],
    }
}

describe("urdf", () => {
    it("carries every example body's skeleton there and back", () => {
        for (const [name, described] of Object.entries(examples)) {
            const world: body.World = described.world
            const anchored = world.anchored === true
            const back = urdf.read(urdf.write({ name: name, frames: [...described.frames], controls: [], senses: [], anchored: anchored, places: [] }), { lapse: RELEASE })
            near(skeletal(back.frames), skeletal(described.frames), name)
            expect(back.anchored, name).toBe(anchored)
        }
    })

    it("carries the joints a body drives and reads, as ros2_control", () => {
        const quadruped = examples.QUADRUPED
        const back = urdf.read(urdf.write({ name: "quadruped", frames: quadruped.frames, controls: quadruped.controls, senses: quadruped.senses, anchored: false, places: [] }), { lapse: RELEASE })
        const control = back.controls[0]!
        expect(control.kind === "vector" && control.components.map(component => component.joint)).toEqual(quadruped.frames.filter(frame => frame.joint).map(frame => frame.name))
        expect(back.senses[0]?.profile).toBe("sensor_msgs/JointState")
        expect(back.senses[0]?.kind === "vector" && back.senses[0].components.length).toBe(36)
    })

    it("reads a robot as ROS describes one: offsets, inertia, ros2_control limits", () => {
        const robot = urdf.read(`<?xml version="1.0"?>
<robot name="rover">
  <link name="base_link">
    <inertial><origin xyz="0 0 0.05" rpy="0 0 0"/><mass value="3.4"/><inertia ixx="0.02" ixy="0" ixz="0" iyy="0.02" iyz="0" izz="0.03"/></inertial>
    <collision><origin xyz="0 0 0.17" rpy="0 0 0"/><geometry><cylinder radius="0.17" length="0.34"/></geometry></collision>
  </link>
  <link name="wheel_left_link"/>
  <link name="camera_optical_frame"/>
  <joint name="wheel_left_joint" type="continuous">
    <parent link="base_link"/><child link="wheel_left_link"/>
    <origin xyz="0 0.117 0.036" rpy="-1.5708 0 0"/><axis xyz="0 0 1"/>
    <limit effort="1.5" velocity="12"/>
  </joint>
  <joint name="camera_joint" type="fixed">
    <parent link="base_link"/><child link="camera_optical_frame"/>
    <origin xyz="0.06 0 0.24" rpy="-1.5708 0 -1.5708"/>
  </joint>
  <ros2_control name="rover" type="system">
    <joint name="wheel_left_joint">
      <command_interface name="velocity"><param name="min">-12</param><param name="max">12</param></command_interface>
      <state_interface name="position"/><state_interface name="velocity"/>
    </joint>
  </ros2_control>
</robot>`, { lapse: { kind: "release", after: 500 } })
        const [base, wheel, camera] = robot.frames
        expect(base!.centre).toEqual([0, 0, 0.05])
        expect(base!.shape).toMatchObject({ kind: "cylinder", radius: 0.17, place: { at: [0, 0, 0.17] } })
        expect(wheel!.joint).toMatchObject({ name: "wheel_left_joint", type: "continuous", limits: { velocity: 12, effort: 1.5 } })
        expect(camera!.axes).toBe("rdf")
        expect(camera!.joint).toBeUndefined()
        expect(robot.controls[0]).toMatchObject({ channel: "/joints", lapse: { kind: "release", after: 500 }, components: [{ name: "wheel_left_joint.velocity", unit: "rad/s", interface: "velocity", joint: "wheel_left_link", range: [-12, 12] }] })
        expect(robot.senses[0]).toMatchObject({ profile: "sensor_msgs/JointState", components: [{ name: "wheel_left_joint.position", unit: "rad" }, { name: "wheel_left_joint.velocity", unit: "rad/s" }] })
        expect(() => manifest.check(worn(robot))).not.toThrow()
    })

    it("reads what Gazebo says a robot senses: a camera through an optical frame, a 3D lidar, an IMU, a GNSS fix on the planet", () => {
        const robot = urdf.read(`<robot name="scout">
  <link name="base_link"/><link name="mast"/>
  <joint name="mast_joint" type="fixed"><parent link="base_link"/><child link="mast"/><origin xyz="0 0 0.5"/></joint>
  <gazebo reference="mast">
    <sensor name="camera" type="camera"><update_rate>30</update_rate>
      <camera><horizontal_fov>1.5708</horizontal_fov><image><width>640</width><height>480</height></image>
        <distortion><k1>-0.2</k1><k2>0.05</k2><k3>0</k3><p1>0.001</p1><p2>0</p2></distortion></camera>
    </sensor>
    <sensor name="lidar" type="gpu_lidar"><pose>0 0 0.1 0 0 0</pose><update_rate>10</update_rate>
      <lidar><scan><horizontal><samples>1024</samples><min_angle>-3.14159</min_angle><max_angle>3.14159</max_angle></horizontal>
        <vertical><samples>16</samples><min_angle>-0.26</min_angle><max_angle>0.26</max_angle></vertical></scan><range><max>100</max></range></lidar>
    </sensor>
  </gazebo>
  <gazebo reference="base_link">
    <sensor name="imu" type="imu"><update_rate>200</update_rate></sensor>
    <sensor name="gps" type="navsat"/>
  </gazebo>
</robot>`, { lapse: RELEASE })
        expect(robot.frames.map(frame => frame.name)).toEqual(["base_link", "mast", "camera_optical_frame", "lidar"])
        expect(robot.frames[2]).toMatchObject({ parent: "mast", axes: "rdf" })
        expect(robot.frames[3]).toMatchObject({ parent: "mast", at: [0, 0, 0.1] })
        const [camera, lidar, imu, gps] = robot.senses
        expect(camera).toMatchObject({ channel: "/camera", frame: "camera_optical_frame", rate: 30, width: 640, height: 480, pixel: { kind: "colour" } })
        expect(camera!.kind === "visual" && camera!.lens).toMatchObject({ kind: "perspective", centre: [320, 240], distortion: { model: "plumb_bob", coefficients: [-0.2, 0.05, 0.001, 0, 0] } })
        expect(camera!.kind === "visual" && camera!.lens.kind === "perspective" && camera!.lens.focal[0]).toBeCloseTo(320, 2)
        expect(lidar).toMatchObject({ frame: "lidar", width: 1024, height: 16, lens: { kind: "polar", elevation: { from: 0.26, to: -0.26 } }, pixel: { kind: "depth", range: 100 } })
        expect(imu).toMatchObject({ channel: "/imu", frame: "base_link", rate: 200, profile: "sensor_msgs/Imu" })
        expect(gps).toMatchObject({ channel: "/gps", frame: "earth" })
        expect(robot.places).toEqual([{ name: "earth", kind: "geodetic", datum: "WGS84" }])
        expect(() => manifest.check(worn(robot))).not.toThrow()
    })

    it("reads the world as the world: fixed to it is anchored, free in it is free, moving along it is not described", () => {
        const joined = (type: string) => `<robot name="r"><link name="world"/><link name="base"/><joint name="j" type="${type}"><parent link="world"/><child link="base"/><origin xyz="0 0 0.8"/></joint></robot>`
        expect(urdf.read(joined("fixed"), { lapse: RELEASE })).toMatchObject({ anchored: true, frames: [{ name: "base", parent: null, at: [0, 0, 0] }] })
        expect(urdf.read(joined("floating"), { lapse: RELEASE })).toMatchObject({ anchored: false, frames: [{ name: "base", parent: null }] })
        expect(() => urdf.read(joined("prismatic"), { lapse: RELEASE })).toThrow("joined to the world by a prismatic joint")
    })

    it("refuses what it cannot represent rather than dropping it", () => {
        expect(() => urdf.read(`<robot name="two"><link name="a"/><link name="b"/></robot>`, { lapse: RELEASE })).toThrow("exactly one is the base")
        expect(() => urdf.read(`<robot name="r"><link name="a"/><gazebo reference="a"><sensor name="s" type="sonar"/></gazebo></robot>`, { lapse: RELEASE })).toThrow("sensor s is a sonar, which this reader cannot describe yet")
        expect(() => urdf.read(`<robot name="r"><link name="a"/><gazebo reference="b"><sensor name="s" type="imu"/></gazebo></robot>`, { lapse: RELEASE })).toThrow("refers to link b")
    })

    describe("real robots, as their makers describe them", () => {
        it("Franka Panda: an arm whose second finger mimics the first — the same arm as the ARM example", () => {
            const panda = urdf.read(robot("franka-panda.urdf"), { lapse: { kind: "keep" } })
            expect(() => manifest.check(worn(panda))).not.toThrow()
            const finger = panda.frames.find(frame => frame.name === "panda_rightfinger")!
            expect(finger.joint?.mimic).toEqual({ joint: "panda_leftfinger", multiplier: 1, offset: 0 })
            for (const frame of examples.ARM.frames.filter(frame => frame.joint)) {
                const read = panda.frames.find(other => other.name === frame.name)!
                expect(read, frame.name).toBeDefined()
                near(read.joint!.axis, frame.joint!.axis, `${frame.name}.axis`)
                near(read.joint!.limits?.position, frame.joint!.limits?.position, `${frame.name}.limits`)
                near(read.at, frame.at, `${frame.name}.at`)
                expect(sameTurn(read.turn, frame.turn), `${frame.name}.turn`).toBe(true)
            }
        })

        it("Unitree Go2: forty-two links, twelve joints — and no word on what drives them", () => {
            const go2 = urdf.read(robot("unitree-go2.urdf"), { lapse: RELEASE })
            expect(go2.frames.length).toBe(42)
            expect(go2.frames.filter(frame => frame.joint).length).toBe(12)
            expect(go2.controls).toEqual([])
            expect(() => manifest.check(worn(go2))).not.toThrow()
        })

        it("TurtleBot3 Burger: two driven wheels, a lidar's link", () => {
            const burger = urdf.read(robot("turtlebot3-burger.urdf"), { lapse: RELEASE })
            expect(burger.frames.filter(frame => frame.joint?.type === "continuous").length).toBe(2)
            expect(() => manifest.check(worn(burger))).not.toThrow()
        })

        it("Crazyflie: a drone free in its world, which is not part of it", () => {
            const crazyflie = urdf.read(robot("crazyflie.urdf"), { lapse: RELEASE })
            expect(crazyflie.anchored).toBe(false)
            expect(crazyflie.frames).toMatchObject([{ name: "base", parent: null, mass: 0.034 }])
            expect(() => manifest.check(worn(crazyflie))).not.toThrow()
        })

        it("NASA's Open Source Rover: rocker-bogie joints driven by ros2_control, an IMU Gazebo declares", () => {
            const rover = urdf.read(robot("nasa-osr.urdf"), { lapse: RELEASE })
            expect(rover.senses.map(sense => sense.channel)).toEqual(["/joints", "/imu_sensor"])
            expect(rover.senses[1]).toMatchObject({ frame: "imu_link", rate: 100, profile: "sensor_msgs/Imu" })
            const control = rover.controls[0]!
            expect(control.kind === "vector" && control.components.length).toBeGreaterThan(6)
            expect(() => manifest.check(worn(rover))).not.toThrow()
        })
    })
})
