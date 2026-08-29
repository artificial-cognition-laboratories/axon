/**
 * core — the raw layer. Escape sequences, width arithmetic, the theme-bound
 * palette, the closed icon set, and the output handle.
 *
 * Nothing here knows what an Axon dev server or a deployment looks like.
 */

export { Renderer, type RendererHandle, type RendererOpts, type CaptureHandle } from "./renderer.ts"
export { Palette, type Paint } from "./color.ts"
export { icons, type IconName } from "./icons.ts"
export { wrap } from "./wrap.ts"
export {
    hyperlink,
    stripAnsi,
    width,
    padEnd,
    truncate,
    CLEAR_LINE,
    COL_0,
    HIDE_CURSOR,
    SHOW_CURSOR,
    cursorUp,
} from "./ansi.ts"
