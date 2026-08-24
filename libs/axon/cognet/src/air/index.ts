// platform/air — Agent Intermediate Representation.
// Air() is the module's single export surface: one grammar, two halves.
//
// Render takes DOMAIN types (AxonTool[], AxonEntry[]) and owns the
// translation into protocol shape. The internal render vocabulary
// (render/blocks.ts's TimelineItem, tool-declaration shaping) is deliberately NOT exported —
// callers pass what they hold, never AIR internals.

export { Air, type AirT, type AirParserT } from "./air"

/**
 * The <scope> block renderer, exported because the CLI's typegen must render
 * the SAME scope the model is shown — if the .d.ts and the <scope> block ever
 * disagreed, the editor would describe capabilities the model does not have.
 * One renderer, two consumers, no second implementation to drift.
 */
export { renderScope } from "./render/blocks"
export type { AirOpts } from "./grammar"
export type {
    AirBlockEvent,
    AirMessage,
    AirMode,
    AirModeType,
    AirRenderInput,
} from "./types"
