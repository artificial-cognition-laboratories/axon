/**
 * Gruvbox — retro groove, in three weights.
 *
 * ── The three ───────────────────────────────────────────────────────────────
 *
 *   gruvbox        the medium ground: warm earth tones on a transparent dark
 *   gruvbox-dark   hard contrast — the same palette over a deeper ground
 *   gruvbox-light  the published light side, on Gruvbox's own cream paper
 *
 * Every colour below is from Gruvbox's own published palette rather than
 * eyeballed, so the chrome agrees with the syntax highlighting inside a code
 * block. A theme whose accent fights its own highlighter is the one thing that
 * makes a terminal look broken rather than styled.
 *
 * The accent is `neutral_aqua`/`bright_aqua` (#83a598) rather than the orange
 * most people associate with Gruvbox. Orange is the palette's WARNING colour
 * (#fe8019 is `bright_orange`), and using it for the accent means every
 * ordinary highlight reads as a caution. Aqua is what Gruvbox itself uses for
 * links and types, and it is the only cool token in the set — which is exactly
 * what makes it legible against all that warmth.
 *
 * ── The bare name is the default variant ────────────────────────────────────
 *
 * `gruvbox` is what a user gets by naming the obvious thing, so it is the
 * MEDIUM weight rather than an alias for either extreme — the same choice
 * Gruvbox itself makes with its `medium` default. The suffixed pair are the
 * deliberate picks.
 *
 * Axon ships only `arcnight`; every other theme name belongs to whoever
 * publishes it. That matters more than it looks: `theme.create()` throws on a
 * duplicate and these files run at module scope, so a name collision does not
 * skip one theme — it throws partway through the file and costs every theme
 * declared after it.
 *
 * ── background: transparent, in all three ───────────────────────────────────
 *
 * No variant paints a ground. The user's terminal background — and its opacity,
 * if they run one — shows through, so Axon sits in the terminal they configured
 * rather than painting a rectangle over it. Someone who runs Gruvbox in their
 * terminal already HAS `bg0` behind them; painting it again would only flatten
 * their transparency.
 *
 * That holds for `gruvbox-light` too: a person selecting a light theme is
 * running a light terminal, so the ground is already right.
 */

// ── gruvbox ──────────────────────────────────────────────────────────────────
//
// The medium weight, and the default. `text` is `fg1` (#ebdbb2), the cream
// Gruvbox uses for body text — warm enough to sit with the earth tones without
// going yellow. `dim` is `gray` (#928374), the palette's own comment colour,
// which is the right call for secondary text: it is the exact value Gruvbox
// already trusts to recede while staying readable.
theme.create("gruvbox", {
    primary: "#83a598",
    background: "transparent",
    text: "#ebdbb2",
    dim: "#928374",
    warn: "#fabd2f",
    error: "#fb4934",
    syntax: "everforest-dark",
})

// ── gruvbox-dark ─────────────────────────────────────────────────────────────
//
// Gruvbox `hard` — for a true-black or near-black terminal, where the medium
// variant's brighter tokens read as too hot.
//
// Every token steps down one rung of Gruvbox's own bright→neutral ladder rather
// than being darkened arbitrarily: aqua #83a598 → #689d6a (`neutral_aqua`),
// yellow #fabd2f → #d79921, red #fb4934 → #cc241d. `text` drops from `fg1` to
// `fg2` (#d5c4a1).
//
// `dim` is the tightest decision in the set. Gruvbox's `gray` is already the
// floor for readable secondary text, so this holds it rather than going lower —
// a `dim` token nobody can read turns every path and timestamp into noise, and
// this is precisely the variant where that would bite.
theme.create("gruvbox-dark", {
    primary: "#689d6a",
    background: "transparent",
    text: "#d5c4a1",
    dim: "#928374",
    warn: "#d79921",
    error: "#cc241d",
    syntax: "everforest-dark",
})

// ── gruvbox-light ────────────────────────────────────────────────────────────
//
// For a LIGHT terminal — every foreground re-picked from Gruvbox's light
// palette rather than reused from above, because a dark theme's colours do not
// invert by lightening them. `text` becomes `dark1` (#3c3836), and the accent
// DARKENS to `faded_aqua` (#427b58) to hold contrast against a pale ground,
// where the same aqua that glows on black washes out entirely. `dim` is
// `#7c6f64` — dark enough to read on cream while still receding.
//
// `background` stays transparent like the others: the user's terminal is the
// ground, and someone selecting a light theme is running a light terminal.
// Painting Gruvbox's own `light0` (#fbf1c7) would override a background they
// already chose and flatten its opacity.
theme.create("gruvbox-light", {
    primary: "#427b58",
    background: "transparent",
    text: "#3c3836",
    dim: "#7c6f64",
    warn: "#b57614",
    error: "#9d0006",
    syntax: "everforest-light",
})
