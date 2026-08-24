/**
 * Nord — desaturated arctic blues. One theme, deliberately.
 *
 * ── Why there is only one ───────────────────────────────────────────────────
 *
 * Nord publishes a single sixteen-colour spec. It has no official light or
 * high-contrast variant, so there is nothing here to expose as a second entry —
 * and inventing `nord-dark` by darkening the real values would ship something
 * Nord never specified under a name that implies it did.
 *
 * The other themes in this registry have several entries because their palettes
 * genuinely have several published variants (Catppuccin's four flavours, Rosé
 * Pine's three, Tokyo Night's three). Nord has one. Matching their shape for
 * consistency would be padding, and it would be the kind of padding a user
 * discovers by selecting a variant that looks subtly wrong.
 *
 * ── The palette ─────────────────────────────────────────────────────────────
 *
 * The calmest set in the registry; nothing in it shouts, which is either the
 * point or the objection. Every value below is from Nord's own spec:
 *
 *   primary  nord8   #88c0d0  Frost — the accent Nord itself leads with
 *   text     nord4   #d8dee9  Snow Storm, the body foreground
 *   dim      #616e88          between nord3 and nord9: Nord's own comment colour
 *   warn     nord13  #ebcb8b  Aurora yellow
 *   error    nord11  #bf616a  Aurora red
 *
 * `dim` is the one value not taken verbatim from the sixteen. Nord's nord3
 * (#4c566a) is specified for UI borders and is too dark to read as text; #616e88
 * is the value Nord's own editor ports use for comments, which is what a `dim`
 * token actually is. A `dim` nobody can read turns every path and timestamp into
 * noise.
 *
 * Axon ships only `arcnight`; every other theme name belongs to whoever
 * publishes it. `theme.create()` throws on a duplicate and this file runs at
 * module scope, so a name collision throws partway through rather than skipping
 * one theme.
 *
 * ── background: transparent ─────────────────────────────────────────────────
 *
 * No ground is painted. The user's terminal background — and its opacity, if
 * they run one — shows through, so Axon sits in the terminal they configured
 * rather than painting a rectangle over it. Someone running Nord in their
 * terminal already HAS nord0 (#2e3440) behind them; painting it again would only
 * flatten their transparency.
 */

theme.create("nord", {
    primary: "#88c0d0",
    background: "transparent",
    text: "#d8dee9",
    dim: "#616e88",
    warn: "#ebcb8b",
    error: "#bf616a",
    syntax: "nord",
})
