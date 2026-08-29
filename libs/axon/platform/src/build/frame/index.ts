// frame — where a project's generated output lives, and converting projects
// that still use the old flat layout.

export { Frame, FRAME, BUNDLE_COGNET_DIR, type FrameT, type FrameArea, type ProjectKind } from "./frame"
export { migrateFrame, type FrameMigration } from "./migrate"
