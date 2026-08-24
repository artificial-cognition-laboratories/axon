/**
 * Rosé Pine — muted rose and gold, in its three published variants.
 *
 * ── The three ───────────────────────────────────────────────────────────────
 *
 *   rose-pine       the default: the darkest ground, the original
 *   rose-pine-moon  a lighter, warmer dark — softer contrast
 *   rose-pine-dawn  the light variant, for a light terminal
 *
 * Rosé Pine publishes exactly these three, each with its own full palette, and
 * every colour below is from that spec rather than derived by lightening a
 * neighbour. Iris is the accent throughout — the muted lilac that makes the set
 * recognisable, and the one token that has to stay put or the three stop reading
 * as one family.
 *
 * The most distinctive palette of the set at a glance: the only warm option
 * here that is not orange.
 *
 * ── The bare name is the default variant ────────────────────────────────────
 *
 * `rose-pine` is what a user gets by naming the obvious thing, so it is the
 * original rather than an alias for either of the others.
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
 * rather than painting a rectangle over it. Someone running Rosé Pine in their
 * terminal already HAS #191724 behind them. That holds for `-dawn` too: a person
 * selecting the light variant is running a light terminal.
 */

// ── rose-pine ────────────────────────────────────────────────────────────────
//
// The default. `text` is Rosé Pine's own Text (#e0def4); `dim` is Muted
// (#6e6a86), the value the spec designates for de-emphasised content — already
// tuned to recede against Base without becoming unreadable.
theme.create("rose-pine", {
    primary: "#c4a7e7",
    background: "transparent",
    text: "#e0def4",
    dim: "#6e6a86",
    warn: "#f6c177",
    error: "#eb6f92",
    syntax: "rose-pine",
})

// ── rose-pine-moon ───────────────────────────────────────────────────────────
//
// Moon: a lighter, warmer dark, over #232136 rather than #191724.
//
// Its accent and text are genuinely the same as the original — Rosé Pine keeps
// Iris and Text fixed across both darks on purpose, which is what makes them one
// theme at two grounds rather than two themes. What moves is Muted: #6e6a86 →
// #908caa, lifted so secondary text still separates from Moon's lighter ground
// where the original's would begin to sink into it. That one token is the
// difference, and it is the token that decides whether a path or timestamp is
// readable.
theme.create("rose-pine-moon", {
    primary: "#c4a7e7",
    background: "transparent",
    text: "#e0def4",
    dim: "#908caa",
    warn: "#f6c177",
    error: "#eb6f92",
    syntax: "rose-pine-moon",
})

// ── rose-pine-dawn ───────────────────────────────────────────────────────────
//
// Dawn, from its own published palette rather than the dark values lightened.
// Every foreground DARKENS to hold contrast against paper: Iris to #907aa9,
// `text` to #575279, and `dim` to Dawn's Muted #9893a5 — light enough to recede
// on cream while still readable.
theme.create("rose-pine-dawn", {
    primary: "#907aa9",
    background: "transparent",
    text: "#575279",
    dim: "#9893a5",
    warn: "#ea9d34",
    error: "#b4637a",
    syntax: "rose-pine-dawn",
})
