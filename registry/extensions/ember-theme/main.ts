/**
 * Ember — a warm terminal palette in three weights.
 *
 * ── The three ───────────────────────────────────────────────────────────────
 *
 *   ember        embers in the dark: mid-warmth, transparent ground
 *   ember-dark   the same fire seen from further away — lower, deeper, quieter
 *   ember-light  daylight: the palette inverted for a light terminal
 *
 * All three share one accent family (orange through amber) so switching between
 * them reads as a change of LIGHTING, not a change of theme. What moves is
 * contrast and ground; the hue stays put.
 *
 * ── The bare name is the default variant ────────────────────────────────────
 *
 * `ember` is the one a user gets by naming the package's obvious name, so it is
 * the middle weight rather than an alias for either extreme. The suffixed pair
 * are the deliberate picks.
 *
 * Axon itself ships only `arcnight`; every other theme name belongs to whoever
 * publishes it. That matters more than it looks: `theme.create()` throws on a
 * duplicate and these files run at module scope, so a name collision does not
 * skip one theme — it throws partway through the file and costs every theme
 * declared after it.
 *
 * ── background: transparent ─────────────────────────────────────────────────
 *
 * The dark themes paint no ground, so the user's own terminal background and
 * its opacity show through. Painting a near-black instead would flatten every
 * translucent terminal into an opaque rectangle — the one thing a user with a
 * tuned terminal notices immediately. `ember-light` is the exception and must
 * paint: it cannot assume the terminal behind it is light.
 */

// ── ember ────────────────────────────────────────────────────────────────────
//
// The default of the three. Text is a warm off-white that stays readable over a
// long session; `dim` is a muted clay, chosen dark enough to recede but light
// enough to stay legible against a dark ground — the failure mode for a `dim`
// token is a path or timestamp nobody can read.
theme.create("ember", {
    primary: "#f0873f",
    background: "transparent",
    text: "#ecd9c6",
    dim: "#9a7a63",
    warn: "#edc25c",
    error: "#e2585a",
    syntax: "monokai",
})

// ── ember-dark ───────────────────────────────────────────────────────────────
//
// Lower and deeper. The accent drops toward red and the foreground pulls back,
// for a dark terminal where the brighter variant reads as too hot.
//
// `dim` here is the tightest decision in the set: any lower and secondary text
// stops being readable on a true-black background, which is exactly the
// terminal this variant is for.
theme.create("ember-dark", {
    primary: "#d96a2c",
    background: "transparent",
    text: "#d4bda8",
    dim: "#8a6650",
    warn: "#d4a949",
    error: "#c94a4a",
    syntax: "monokai",
})

// ── ember-light ──────────────────────────────────────────────────────────────
//
// The inversion, and the only one that paints its own ground: a light theme
// cannot let a dark terminal show through, so `background` is a warm paper
// rather than `transparent`.
//
// Every foreground is re-picked rather than reused. A dark theme's colours do
// not invert by lightening them — `text` becomes a deep brown-black, and the
// accent DARKENS to hold contrast against paper, where the same orange that
// glows on black would wash out completely.
theme.create("ember-light", {
    primary: "#b8501a",
    background: "transparent",
    text: "#3a2c22",
    dim: "#8a7261",
    warn: "#9a6b12",
    error: "#b3322f",
    syntax: "github-light",
})
