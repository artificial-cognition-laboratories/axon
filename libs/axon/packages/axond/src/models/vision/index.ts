// vision — the image tasks a pipeline cannot shape: dense features at the
// caller's resolution, masks at points, and depth over the whole picture.

export { Depth } from "./depth"
export { Features } from "./features"
export { Offload, type OffloadT } from "./offload"
export { Segmenter } from "./masks"
export { tensor } from "./tensor"
export type { TaskName } from "./protocol"
export type { Device, VisionLibrary, VisionTask } from "./types"
