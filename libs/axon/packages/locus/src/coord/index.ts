export { coord, from, empty, read, measured, claims, assertBasis } from "./coord"
export { distance, similarity, generalisation, explain, SHEPARD_DECAY, type DistanceOpts, type DomainDistance } from "./distance"
export { conjunction, disjunction, complement, match, TNORMS, TCONORMS, type TNorm, type TConorm } from "./logic"
export { commonality, difference, centroid, interpolate, shift } from "./shape"
export {
    region,
    fit,
    membership,
    has,
    nearestPrototype,
    claimants,
    absorb,
    DEFAULT_RADIUS,
    FIT_SIGMAS,
    type Region,
    type RegionOpts,
} from "./region"
export { trajectory, type TrajectoryHandle, type TrajectoryOpts } from "./trajectory"
export type { Coord, Reading, Gap } from "./types"
