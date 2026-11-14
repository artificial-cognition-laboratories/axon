import { read } from "./read"
import { write } from "./write"

/**
 * urdf — a body's skeleton to and from URDF, the robot description ROS
 * reads, with the sensors Gazebo declares beside it.
 */
export const urdf = {
    read: read,
    write: write,
}

export type { Skeleton } from "./types"
