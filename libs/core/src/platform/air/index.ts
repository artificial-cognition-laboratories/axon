// platform/air — Agent Intermediate Representation.
// Air() is the module's single export surface: one grammar, two halves.
//
// Render takes DOMAIN types (AxonTool[], AxonEntry[]) and owns the
// translation into protocol shape. The internal render vocabulary
// (render/blocks.ts's TimelineItem, tool-declaration shaping) is deliberately NOT exported —
// callers pass what they hold, never AIR internals.

export { Air, type AirT, type AirParserT } from "./air"
export type { AirOpts } from "./grammar"
export type {
    AirBlockEvent,
    AirMessage,
    AirMode,
    AirModeType,
    AirRenderInput,
} from "./types"
