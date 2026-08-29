/**
 * color — the seven theme tokens, as terminal escape sequences.
 *
 * Axon's colours are defined once in `@arcforge/theme`'s closed seven-token set.
 * This module is the only place in arcline that turns those hex values into
 * ANSI, which is what keeps the CLI and the TUI the same colour: a theme
 * change lands on both, and neither can invent an eighth colour.
 *
 * That closed set is the whole point (see themes.ts) — the TUI reached ~30
 * accidental hard-coded colours before it was imposed. So there is no
 * `color.magenta` here and there should never be one. If a surface needs to
 * distinguish something it does so with weight, icon or layout, not by
 * reaching for a colour nobody chose.
 */

import { arcnightTheme } from "@arcforge/theme"
import type { Theme } from "@arcforge/types"
import { ESC, RESET, BOLD, FAINT } from "./ansi.ts"

/** Truecolor foreground from a #rrggbb string. */
function fg(hex: string): string {
    const n = parseInt(hex.slice(1), 16)
    return `${ESC}[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}

export type Paint = (text: string) => string

/** The paint functions a surface draws with — one per theme token, plus weight. */
export type Palette = {
    primary: Paint
    text: Paint
    dim: Paint
    warn: Paint
    error: Paint
    bold: Paint
    /**
     * Dim, one step quieter still — for pure scaffolding like tree connectors.
     *
     * NOT an eighth colour: it is the `dim` token with the ANSI faint
     * attribute on top, so it stays inside the closed seven-token set and a
     * theme cannot forget to define it. Structural glyphs need to sit BELOW
     * the quietest text, and without this they compete with the names they are
     * supposed to be organising.
     */
    faint: Paint
    /** No colour at all — what every paint collapses to when colour is off. */
    plain: Paint
}

const plain: Paint = text => text

/**
 * Build a palette from a theme.
 *
 * `enabled: false` returns a palette whose every entry is identity. Callers
 * therefore never branch on whether colour is on — they always paint, and a
 * non-TTY simply receives unstyled text. That is what keeps escape codes out
 * of piped output without a single `if (isTTY)` in a component.
 */
export function Palette(opts: { theme?: Theme; enabled: boolean }): Palette {
    if (!opts.enabled) {
        return { primary: plain, text: plain, dim: plain, warn: plain, error: plain, bold: plain, faint: plain, plain }
    }

    const theme = opts.theme ?? arcnightTheme
    const paint = (hex: string): Paint => text => `${fg(hex)}${text}${RESET}`

    return {
        primary: paint(String(theme.primary)),
        text:    paint(String(theme.text)),
        dim:     paint(String(theme.dim)),
        warn:    paint(String(theme.warn)),
        error:   paint(String(theme.error)),
        bold:    text => `${BOLD}${text}${RESET}`,
        faint:   text => `${FAINT}${fg(String(theme.dim))}${text}${RESET}`,
        plain,
    }
}
