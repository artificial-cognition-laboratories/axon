/**
 * ansi — raw escape sequences and width arithmetic. No colour decisions here;
 * those belong to `color.ts`, which is the only module that knows the theme.
 */

export const ESC = "\u001b"
export const RESET = `${ESC}[0m`
export const BOLD = `${ESC}[1m`
/** Reduced intensity. Composes with a colour to sit below it. */
export const FAINT = `${ESC}[2m`

// Cursor & line control — used only by the live renderer, never by a component.
export const CLEAR_LINE = `${ESC}[2K`
export const COL_0 = `${ESC}[0G`
export const HIDE_CURSOR = `${ESC}[?25l`
export const SHOW_CURSOR = `${ESC}[?25h`
export const cursorUp = (n: number): string => (n > 0 ? `${ESC}[${n}A` : "")

/** OSC 8 clickable hyperlink — works in VS Code, iTerm2, Warp, Ghostty. */
export function hyperlink(url: string, text: string): string {
    return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`
}

const ANSI_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]|\u001b\]8;;[^\u001b]*\u001b\\/g

export function stripAnsi(str: string): string {
    return str.replace(ANSI_PATTERN, "")
}

/**
 * Printable width of a string.
 *
 * Escape sequences are stripped first — a coloured string is not wider than
 * the same string uncoloured, and every layout calculation in this package
 * depends on that being true.
 */
export function width(str: string): number {
    return stripAnsi(str).length
}

/** Pad to a target PRINTABLE width, ignoring any escape sequences within. */
export function padEnd(str: string, target: number, char = " "): string {
    const w = width(str)
    return w >= target ? str : str + char.repeat(target - w)
}

/** Truncate to a target printable width, appending an ellipsis when cut. */
export function truncate(str: string, target: number): string {
    if (width(str) <= target) return str
    return stripAnsi(str).slice(0, Math.max(0, target - 1)) + "…"
}
