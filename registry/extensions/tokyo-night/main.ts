/**
 * Tokyo Night — cool, high-contrast blues, in its three published variants.
 *
 * ── The three ───────────────────────────────────────────────────────────────
 *
 *   tokyo-night        the default: the darkest ground, highest contrast
 *   tokyo-night-storm  the same palette over a lighter slate — softer, less stark
 *   tokyo-night-day    the light variant, for a light terminal
 *
 * These are the variants Tokyo Night itself ships (Night, Storm, Day), not
 * weights invented here. Night and Storm share one foreground palette and
 * differ in ground, which is exactly why Storm is worth its own entry: on a
 * terminal that is not true black, Night's contrast reads as harsh.
 *
 * The accent is Blue (#7aa2f7) — the colour the theme is known for, and the one
 * token that has to stay put across all three or they stop being one family.
 *
 * ── The bare name is the default variant ────────────────────────────────────
 *
 * `tokyo-night` is what a user gets by naming the obvious thing, so it is Night
 * rather than an alias for either of the others.
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
 * rather than painting a rectangle over it. Someone running Tokyo Night in
 * their terminal already HAS #1a1b26 behind them. That holds for `-day` too: a
 * person selecting the light variant is running a light terminal.
 */

// ── tokyo-night ──────────────────────────────────────────────────────────────
//
// The default, and the most legible of the dark blues. `text` is the theme's own
// foreground (#c0caf5); `dim` is #565f89, its comment colour — already tuned to
// recede against a dark ground without becoming unreadable, which is the whole
// job of a `dim` token.
theme.create("tokyo-night", {
    primary: "#7aa2f7",
    background: "transparent",
    text: "#c0caf5",
    dim: "#565f89",
    warn: "#e0af68",
    error: "#f7768e",
    syntax: "tokyo-night",
})

// ── tokyo-night-storm ────────────────────────────────────────────────────────
//
// Storm keeps Night's foregrounds and lifts the ground from #1a1b26 to #24283b.
// Since nothing here paints a background, the foregrounds are what carry the
// difference: `dim` lifts to #737aa2 so secondary text still separates from a
// lighter slate, where Night's #565f89 would start to sink into it.
theme.create("tokyo-night-storm", {
    primary: "#7aa2f7",
    background: "transparent",
    text: "#c0caf5",
    dim: "#737aa2",
    warn: "#e0af68",
    error: "#f7768e",
    syntax: "tokyo-night",
})

// ── tokyo-night-day ──────────────────────────────────────────────────────────
//
// The light variant, from Tokyo Night's own Day palette rather than the dark
// values lightened. Every foreground DARKENS to hold contrast against paper:
// the accent to #2e7de9, `text` to #3760bf, and `dim` to #848cb5 — dark enough
// to read on white while still receding.
//
// `syntax` borrows vitesse-light: Shiki bundles no Tokyo Night light, and this is
// the closest in feel — cool and low-saturation, where github-light is warmer and
// higher-contrast enough to fight the chrome around it. Borrowing is stated here
// rather than hidden, because a theme whose accent disagrees with its own
// highlighter is what makes a terminal look broken rather than styled.
theme.create("tokyo-night-day", {
    primary: "#2e7de9",
    background: "transparent",
    text: "#3760bf",
    dim: "#848cb5",
    warn: "#8c6c3e",
    error: "#f52a65",
    syntax: "vitesse-light",
})
