/**
 * arcline — unified CLI rendering for the Axon platform.
 *
 * ── The three layers ───────────────────────────────────────────────────────
 *
 *   core/        escape sequences, width arithmetic, the theme-bound palette,
 *                the closed icon set, and the Renderer output handle.
 *   components/  the composable vocabulary — header, rows, tree, table,
 *                status, errorReport. Pure: (renderer, opts) => lines.
 *   views/       whole Axon surfaces composed from components — devServer and
 *                friends. Also pure: (renderer, opts) => string.
 *
 * Purity is the load-bearing property. A view returns a string rather than
 * printing, so it can be snapshot-tested, composed into a larger frame, or
 * repainted by a live surface — and the gallery (`arcline <view>`) can render
 * every one of them with fixture data.
 *
 * Interactive surfaces (spinners, multi-step progress, prompts) are the one
 * exception and are a different KIND: they own the cursor and have a
 * lifecycle, so they are handles rather than functions. They live alongside
 * views and repaint by calling a pure view for each frame.
 */

export * from "./core/index.ts"
export * from "./components/index.ts"
export * from "./views/index.ts"
export * from "./live/index.ts"

/** Elapsed-time helper — the one thing every CLI command needs and no view owns. */
export const timer = {
    start: (): number => performance.now(),
    end: (start: number): number => Math.round(performance.now() - start),
}
