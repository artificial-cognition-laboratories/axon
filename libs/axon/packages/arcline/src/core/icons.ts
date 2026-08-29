/**
 * icons — the closed glyph set.
 *
 * Same reasoning as the seven colour tokens: a set that anyone can extend at
 * a call site stops being a language. Nine glyphs cover every state an Axon
 * CLI surface has ever needed to express, and a tenth should be argued for
 * rather than added.
 *
 * They are deliberately uncoloured. A glyph means a STATE; the colour comes
 * from the palette at the point of use, so the same `icons.ok` reads correctly
 * in a success line and in a dimmed, already-completed step.
 */
export const icons = {
    /** Completed successfully. */
    ok: "✓",
    /** Failed. */
    fail: "✗",
    /** In progress — the static stand-in for a spinner on a non-TTY. */
    pending: "•",
    /** Neutral information. */
    info: "ℹ",
    /** Something the user should notice but which did not fail. */
    warn: "⚠",
    /** Points at a destination — a URL, a next step. */
    arrow: "➜",
    /** Tree: a child with siblings following it. */
    tee: "├─",
    /** Tree: the last child. */
    elbow: "└─",
    /** Tree: vertical continuation beneath a `tee`. */
    pipe: "│",

    // ── Registry metrics ────────────────────────────────────────────────────
    // Two glyphs rather than the words "stars" and "installs", because these
    // appear on every row of a list and a repeated word is what turns a
    // scannable list into a wall. Both are conventional enough to need no
    // legend — the star from every package registry, the down-arrow from every
    // download counter.

    /** Stars on a registry artifact. */
    star: "★",
    /** Installs / downloads. */
    installs: "↓",
} as const

export type IconName = keyof typeof icons
