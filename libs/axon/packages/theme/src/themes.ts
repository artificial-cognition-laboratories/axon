/**
 * Themes — the seven tokens every Axon surface draws from.
 *
 * ── Why seven, and why closed ───────────────────────────────────────────────
 *
 * The TUI reached ~30 distinct hard-coded colours: four greys that nobody chose
 * deliberately, five reds, two blues. Most of that variety is accidental rather
 * than meaningful, and a theme API with a field per call site would preserve
 * the accident forever — a "theme" would then mean thirty decisions, and no two
 * themes would agree on what any of them were for.
 *
 * So the set is closed. A theme picks seven colours; every surface derives from
 * them. That is what makes a theme portable: whatever an author writes, it
 * lands on the same things in the same way.
 */

/**
 * Re-exported, not redefined.
 *
 * These types are the EXTENSION CONTRACT — a user's `theme.create()` is typed
 * against the copy in `@arcforge/types/tui.ts`, which `axon prepare` writes
 * into their frame. A second definition here would be the same shape twice,
 * and the day they disagreed a theme would typecheck in a user's editor and be
 * rejected by the terminal that loaded it.
 *
 * `BundledSyntax` in particular is generated from Shiki's own bundle, so
 * duplicating it would mean duplicating the generator too.
 */
export type { ThemeColor, ColorName, ThemeTokens, Theme, BundledSyntax } from "@arcforge/types"

import type { Theme, ThemeTokens } from "@arcforge/types"

/**
 * Arcnight — the default, and the palette every Axon surface was built against.
 *
 * `primary` is the cyan the input rule, palette selection and header already
 * use; `dim` is the grey that most secondary text collapsed to; `error` is the
 * red the timeline's error rows use. Those three were already consistent —
 * the rest of the variety is what this set replaces.
 */
export const arcnightTheme: Theme = {
    name: "arcnight",
    primary: "#00B4D8",
    background: "transparent",
    text: "#a8a8a8",
    dim: "#6e6e6e",
    warn: "#dca05a",
    error: "#dc7878",
    syntax: "arcnight",
}

/**
 * The themes Axon ships. A user's config adds to these; it never replaces them.
 *
 * ── Exactly one, deliberately ───────────────────────────────────────────────
 *
 * There was a second built-in — `ember` — added "purely so switching is
 * testable: one theme cannot demonstrate that anything is actually themed."
 * That reason expired the moment themes became installable: switching is now
 * demonstrated by any published theme, and the built-in was doing nothing but
 * occupying a name.
 *
 * And occupying a name is not free. `theme.create()` throws on a duplicate,
 * and an extension registers at module scope — so a built-in squatting an
 * obvious name does not merely shadow one theme, it throws partway through the
 * file and costs every theme declared after it. `@axon/ember-theme` hit exactly
 * that: the package could not register its own primary theme.
 *
 * So the rule this list follows: Axon ships the ONE theme it is designed
 * around, and every other name belongs to whoever publishes it. A built-in
 * added here is a name permanently taken from the ecosystem.
 */
export const BUILTIN_THEMES: readonly Theme[] = [arcnightTheme]

/**
 * Tokens as the CSS variables a stylesheet references.
 *
 * `syntax` is deliberately absent: it is a Shiki theme, not a colour, and is
 * applied through the highlighter rather than by any `var()`.
 */
export function themeVariables(theme: ThemeTokens): Record<string, string> {
    return {
        primary: String(theme.primary),
        background: String(theme.background),
        text: String(theme.text),
        dim: String(theme.dim),
        warn: String(theme.warn),
        error: String(theme.error),
    }
}
