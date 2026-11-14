import type { body } from "@arcforge/types"

/**
 * What the example bodies share: the turns that put a camera's optical axes
 * on a part, the common kinds of component, and a pinhole from its field of
 * view.
 */

type Quat = [number, number, number, number]

export const STILL: Quat = [0, 0, 0, 1]
/** Quarter turns that put a camera's optical axes (rdf) on a part's (flu), looking along the part's x. */
export const LOOKING_FORWARD: Quat = [-0.5, 0.5, -0.5, 0.5]
/** The same, looking along the part's y — into a side-on world. */
export const LOOKING_SIDEWAYS: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
/** The same, looking along the part's −z — straight down. */
export const LOOKING_DOWN: Quat = [1, 0, 0, 0]

export const SWITCH = { unit: "bool", interface: "switch" } as const
export const BOOL = { unit: "bool" } as const
export const COLOUR = { kind: "colour" } as const
export const REAL = { kind: "real" } as const

/** An inertial unit's six components, each `noise` (accel, gyro) off. */
export function imu(noise: [number, number]): body.Component[] {
    return [
        ...["accel.x", "accel.y", "accel.z"].map(name => ({ name: name, unit: "m/s²", noise: noise[0] })),
        ...["gyro.x", "gyro.y", "gyro.z"].map(name => ({ name: name, unit: "rad/s", noise: noise[1] })),
    ]
}

/** A distortion-free pinhole of vertical field of view `fov` rad, its optical centre in the middle of a `width`×`height` picture. */
export function pinhole(width: number, height: number, fov: number): body.Lens {
    const focal = height / 2 / Math.tan(fov / 2)
    return { kind: "perspective", focal: [focal, focal], centre: [width / 2, height / 2] }
}

/** URDF's roll, pitch, yaw — fixed axes x, then y, then z — as a quaternion [x, y, z, w]. */
export function rpy(roll: number, pitch: number, yaw: number): Quat {
    const [cr, sr] = [Math.cos(roll / 2), Math.sin(roll / 2)]
    const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)]
    const [cy, sy] = [Math.cos(yaw / 2), Math.sin(yaw / 2)]
    return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy]
}
