import { err } from "@arcforge/err"
import type { body } from "@arcforge/types"
import { rotation } from "./rotation"
import type { Element } from "./types"

type Vec3 = [number, number, number]

/** The turn that puts a camera's optical axes (rdf) on the link it looks along the x of — what Gazebo's cameras do. */
const OPTICAL: [number, number, number, number] = [-0.5, 0.5, -0.5, 0.5]
const EARTH: body.Place = { name: "earth", kind: "geodetic", datum: "WGS84" }

/** What Gazebo's `<sensor>`s add to a skeleton: senses, the frames they look from, and the places they read in. */
export type Sensed = { senses: body.Sense[]; frames: body.Frame[]; places: body.Place[] }

/**
 * sensors — what a URDF's `<gazebo reference="link"><sensor>` blocks say a
 * robot senses, which URDF itself cannot. Each sensor is a sense on
 * `/<name>`; one with a pose of its own on its link sits on a frame of its
 * own; a camera looks from an optical frame (`rdf`) added on its link, since
 * Gazebo's cameras look along their link's x. A sensor of a kind not
 * described here is refused, by name, rather than dropped.
 */
export const sensors = {
    read(robot: Element, links: Set<string>): Sensed {
        const found: Sensed = { senses: [], frames: [], places: [] }
        for (const block of (robot.gazebo ?? []) as Element[]) {
            const link = block.reference
            if (link === undefined) continue
            if (!links.has(link)) fail(`a <gazebo> block refers to link ${link}, which the robot does not have`)
            for (const sensor of (block.sensor ?? []) as Element[]) sensors.one(sensor, link, found)
        }
        return found
    },

    one(sensor: Element, link: string, found: Sensed): void {
        const name = sensor.name
        if (typeof name !== "string" || name === "") fail(`a sensor on ${link} has no name`)
        const kind = TYPES[sensor.type as string]
        if (!kind) fail(`sensor ${name} is a ${sensor.type}, which this reader cannot describe yet`)
        const frame = sensors.mount(sensor, link, name, found)
        const rate = sensor.update_rate === undefined ? {} : { rate: read.number(sensor.update_rate, `sensor ${name}'s update rate`) }
        kinds[kind]({ sensor: sensor, name: name, link: link, frame: frame, rate: rate, found: found })
    },

    /** The frame a sensor reads in: its link, or a frame of its own where its pose moves it off the link. */
    mount(sensor: Element, link: string, name: string, found: Sensed): string {
        if (sensor.pose === undefined) return link
        const [x, y, z, roll, pitch, yaw] = read.numbers(sensor.pose, 6, `sensor ${name}'s pose`)
        if ([x, y, z, roll, pitch, yaw].every(value => value === 0)) return link
        found.frames.push({ name: name, parent: link, axes: "flu", at: [x!, y!, z!], turn: rotation.fromRpy(roll!, pitch!, yaw!) })
        return name
    },
}

/** One sensor being read: the element, its name, the link it is on, the frame it reads in, and where what it adds goes. */
type Reading = { sensor: Element; name: string; link: string; frame: string; rate: { rate?: number }; found: Sensed }

/** Each Gazebo sensor type, by the reader that describes it. */
const TYPES: Record<string, keyof typeof kinds> = {
    imu: "imu",
    magnetometer: "magnetometer",
    gps: "gnss",
    navsat: "gnss",
    camera: "camera",
    depth: "depth",
    depth_camera: "depth",
    rgbd_camera: "depth",
    ray: "scanner",
    gpu_ray: "scanner",
    lidar: "scanner",
    gpu_lidar: "scanner",
}

/** What each kind of sensor is, as senses. */
const kinds = {
    imu({ name, frame, rate, found }: Reading): void {
        found.senses.push({
            channel: `/${name}`, kind: "vector", frame: frame, ...rate, profile: "sensor_msgs/Imu",
            components: [...["accel.x", "accel.y", "accel.z"].map(axis => ({ name: axis, unit: "m/s²" })), ...["gyro.x", "gyro.y", "gyro.z"].map(axis => ({ name: axis, unit: "rad/s" }))],
        })
    },

    magnetometer({ name, frame, rate, found }: Reading): void {
        found.senses.push({ channel: `/${name}`, kind: "vector", frame: frame, ...rate, profile: "sensor_msgs/MagneticField", components: ["x", "y", "z"].map(axis => ({ name: `field.${axis}`, unit: "T" })) })
    },

    /** A fix on the planet: read in the earth place, which it adds. */
    gnss({ name, rate, found }: Reading): void {
        if (!found.places.some(place => place.name === EARTH.name)) found.places.push(EARTH)
        found.senses.push({
            channel: `/${name}`, kind: "vector", frame: EARTH.name, ...rate, profile: "sensor_msgs/NavSatFix",
            components: [{ name: "latitude", unit: "rad" }, { name: "longitude", unit: "rad" }, { name: "altitude", unit: "m" }],
        })
    },

    camera(reading: Reading): void {
        const camera = cameras.optical(reading)
        reading.found.senses.push({ channel: `/${reading.name}`, kind: "visual", frame: camera.frame, ...reading.rate, width: camera.width, height: camera.height, lens: camera.lens, pixel: { kind: "colour" } })
    },

    /** A depth camera is two pictures through one lens: colour on `/<name>`, depth on `/<name>.depth`, out to its far clip. */
    depth(reading: Reading): void {
        const camera = cameras.optical(reading)
        const far = read.number(reading.sensor.camera?.clip?.far, `camera ${reading.name}'s far clip`)
        const picture = { kind: "visual", frame: camera.frame, ...reading.rate, width: camera.width, height: camera.height, lens: camera.lens } as const
        reading.found.senses.push({ channel: `/${reading.name}`, ...picture, pixel: { kind: "colour" } }, { channel: `/${reading.name}.depth`, ...picture, pixel: { kind: "depth", range: far } })
    },

    /** A lidar: a depth picture through a polar lens, a column a direction, a row an elevation. */
    scanner({ sensor, name, frame, rate, found }: Reading): void {
        const ray = sensor.ray ?? sensor.lidar
        if (!ray?.scan?.horizontal) fail(`scanner ${name} has no horizontal scan`)
        const horizontal = ray.scan.horizontal
        const vertical = ray.scan.vertical
        const rows = vertical ? read.number(vertical.samples, `scanner ${name}'s vertical samples`) : 1
        const elevation = rows > 1
            ? { from: read.number(vertical.max_angle, `scanner ${name}'s top`), to: read.number(vertical.min_angle, `scanner ${name}'s bottom`) }
            : [vertical?.min_angle === undefined ? 0 : read.number(vertical.min_angle, `scanner ${name}'s elevation`)]
        found.senses.push({
            channel: `/${name}`, kind: "visual", frame: frame, ...rate, profile: "sensor_msgs/LaserScan",
            width: read.number(horizontal.samples, `scanner ${name}'s samples`), height: rows,
            lens: { kind: "polar", from: read.number(horizontal.min_angle, `scanner ${name}'s first angle`), to: read.number(horizontal.max_angle, `scanner ${name}'s last angle`), elevation: elevation },
            pixel: { kind: "depth", range: read.number(ray.range?.max, `scanner ${name}'s range`) },
        })
    },
}

/** A Gazebo camera's picture and the optical frame it is taken in. */
const cameras = {
    optical({ sensor, name, frame, found }: Reading): { frame: string; width: number; height: number; lens: body.Lens } {
        const camera = sensor.camera
        if (!camera) fail(`camera ${name} has no <camera>`)
        const width = read.number(camera.image?.width, `camera ${name}'s width`)
        const height = read.number(camera.image?.height, `camera ${name}'s height`)
        const fov = read.number(camera.horizontal_fov, `camera ${name}'s field of view`)
        const focal = width / 2 / Math.tan(fov / 2)
        const optical = `${name}_optical_frame`
        found.frames.push({ name: optical, parent: frame, axes: "rdf", at: [0, 0, 0] as Vec3, turn: OPTICAL })
        return { frame: optical, width: width, height: height, lens: { kind: "perspective", focal: [focal, focal], centre: [width / 2, height / 2], ...cameras.distortion(camera.distortion) } }
    },

    /** Gazebo's k1 k2 k3 p1 p2, as a plumb bob — none when every one is zero. */
    distortion(distortion: Element | undefined): { distortion?: body.Distortion } {
        if (!distortion) return {}
        const [k1, k2, k3, p1, p2] = ["k1", "k2", "k3", "p1", "p2"].map(key => distortion[key] === undefined ? 0 : read.number(distortion[key], `distortion ${key}`))
        const coefficients = [k1!, k2!, p1!, p2!, k3!]
        return coefficients.every(value => value === 0) ? {} : { distortion: { model: "plumb_bob", coefficients: coefficients } }
    },
}

const read = {
    number(value: unknown, what: string): number {
        const number = Number(typeof value === "object" && value !== null ? (value as Element)["#text"] : value)
        if (value === undefined || !Number.isFinite(number)) fail(`${what} is not a number: ${String(value)}`)
        return number
    },
    numbers(text: unknown, length: number, what: string): number[] {
        const values = String(text).trim().split(/\s+/).map(part => read.number(part, what))
        if (values.length !== length) fail(`${what} is not ${length} numbers: ${String(text)}`)
        return values
    },
}

function fail(detail: string): never {
    throw err("BODY_URDF_INVALID", { detail: detail })
}
