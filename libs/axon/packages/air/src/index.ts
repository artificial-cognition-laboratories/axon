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
    AirProtocolName,
    AirRenderInput,
    AirState,
    AirStateLang,
    AirTextLang,
} from "./types"

/**
 * The scope, spelled for `tsc` rather than for a model — the sibling of
 * renderScope(). Exported because the CLI's typegen writes it to disk as
 * tool-globals.d.ts: if the editor's declarations and the <scope> block
 * disagreed, the editor would describe capabilities the model does not have.
 */
export { scopeToDts, scopeMemberCount } from "./scope-dts"

/**
 * `Output` is deliberately NOT re-exported here — import it from
 * `@arcforge/air/output`.
 *
 * It carries the TypeScript compiler, and this index is what every cognet
 * imports to get `Air()`. A barrel export put `typescript` in the bundle of
 * every agent that renders a prompt, which is how it first surfaced: a
 * scaffolded agent failed to compile its brain on a dependency it had no
 * reason to have. The checker runs HOST-side, so the subpath keeps it out of
 * the artifact that ships.
 */
