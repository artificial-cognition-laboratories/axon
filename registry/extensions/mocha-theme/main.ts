/**
 * Catppuccin — the warm pastel set, in its four published flavours.
 *
 * ── The four ────────────────────────────────────────────────────────────────
 *
 *   mocha        the darkest and the default — what most people mean
 *   macchiato    one step lighter, slightly softer contrast
 *   frappe       the mid flavour: muted, the least contrast of the darks
 *   latte        the light flavour, for a light terminal
 *
 * These are not invented weights. Catppuccin publishes exactly these four, each
 * with its own full palette, and every colour below is taken from that spec
 * rather than derived by lightening a neighbour — which is why the four read as
 * one family instead of one theme at four brightnesses.
 *
 * The accent is Lavender in all four, rather than Blue. Against Catppuccin's
 * muted foregrounds the blue sits too close to the text; lavender is the
 * accent that stays distinct without shouting, and it is the one token that
 * makes the set recognisable at a glance.
 *
 * ── The bare name is the default flavour ────────────────────────────────────
 *
 * `mocha` is what a user gets by naming the obvious thing, and it is the
 * flavour Catppuccin itself leads with. The other three are the deliberate
 * picks.
 *
 * Axon ships only `arcnight`; every other theme name belongs to whoever
 * publishes it. That matters more than it looks: `theme.create()` throws on a
 * duplicate and these files run at module scope, so a name collision does not
 * skip one theme — it throws partway through the file and costs every theme
 * declared after it.
 *
 * ── background: transparent, in all four ────────────────────────────────────
 *
 * No flavour paints a ground. The user's terminal background — and its opacity,
 * if they run one — shows through, so Axon sits in the terminal they configured
 * rather than painting a rectangle over it. Someone running Catppuccin in their
 * terminal already HAS Base behind them; painting it again would only flatten
 * their transparency. That holds for `latte` too: a person selecting the light
 * flavour is running a light terminal.
 */

// ── mocha ────────────────────────────────────────────────────────────────────
//
// The default. Text is Catppuccin's own Text (#cdd6f4); `dim` is Overlay0
// (#6c7086), the value the spec designates for de-emphasised content — the
// right call for secondary text, because it is already tuned to recede against
// Base without becoming unreadable.
theme.create("mocha", {
    primary: "#b4befe",
    background: "transparent",
    text: "#cdd6f4",
    dim: "#6c7086",
    warn: "#f9e2af",
    error: "#f38ba8",
    syntax: "catppuccin-mocha",
})

// ── macchiato ────────────────────────────────────────────────────────────────
//
// One step lighter than Mocha. Every token is Macchiato's own — Lavender
// #b7bdf8, Text #cad3f5, Overlay0 #6e738d — not Mocha's values nudged.
theme.create("macchiato", {
    primary: "#b7bdf8",
    background: "transparent",
    text: "#cad3f5",
    dim: "#6e738d",
    warn: "#eed49f",
    error: "#ed8796",
    syntax: "catppuccin-macchiato",
})

// ── frappe ───────────────────────────────────────────────────────────────────
//
// The most muted of the three darks, and the lowest contrast. Worth having as
// its own entry rather than being skipped: it is the flavour for people who
// find Mocha too saturated over a long session.
theme.create("frappe", {
    primary: "#babbf1",
    background: "transparent",
    text: "#c6d0f5",
    dim: "#737994",
    warn: "#e5c890",
    error: "#e78284",
    syntax: "catppuccin-frappe",
})

// ── latte ────────────────────────────────────────────────────────────────────
//
// The light flavour. Note that these are NOT the dark values lightened — Latte
// is its own published palette, and its accent DARKENS to #7287fd to hold
// contrast against a pale ground where Mocha's lavender would vanish. `text` is
// Latte's Text (#4c4f69) and `dim` its Overlay0 (#9ca0b0).
theme.create("latte", {
    primary: "#7287fd",
    background: "transparent",
    text: "#4c4f69",
    dim: "#9ca0b0",
    warn: "#df8e1d",
    error: "#d20f39",
    syntax: "catppuccin-latte",
})
