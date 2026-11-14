type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

/** Quaternions [x, y, z, w] to and from URDF's roll, pitch, yaw — fixed axes x, then y, then z. */
export const rotation = {
    fromRpy(roll: number, pitch: number, yaw: number): Quat {
        const [cr, sr] = [Math.cos(roll / 2), Math.sin(roll / 2)]
        const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)]
        const [cy, sy] = [Math.cos(yaw / 2), Math.sin(yaw / 2)]
        return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy]
    },
    toRpy([x, y, z, w]: Quat): Vec3 {
        const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
        const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))))
        const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
        return [roll, pitch, yaw]
    },
    matrix([x, y, z, w]: Quat): number[][] {
        return [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    },
}
