/** One producer's answer for one axis, with the width of its own uncertainty. */
export type Reading = {
    /** The membership degree, [0,1]. */
    value: number
    /**
     * How much to trust it, [0,1]. **Zero means never measured**, which is the
     * one distinction a sparse map cannot make: "not noisy" and "nobody looked
     * at noisiness" are different facts, and only the second is worth noticing.
     */
    confidence: number
}

/**
 * A position in one basis. Dense, immutable, comparable only within its space.
 *
 * Dense rather than a keyed map so a missing axis is unrepresentable rather
 * than ambiguous, and so the thing is a real vector that arithmetic is cheap
 * over. `space` is the basis fingerprint, carried so a cross-version comparison
 * fails loudly instead of returning a plausible number.
 *
 * Float32 rather than Float64: at a million rows and a hundred axes that is the
 * difference between 240MB and 480MB resident, and a membership degree carries
 * nowhere near seven significant figures of real information. The consequence is
 * that a reading reads back as the NEAREST Float32 — `0.8` in is `0.80000001`
 * out — so compare values with a tolerance, never with equality. Predicate
 * thresholds are rounded into this precision for the same reason.
 */
export type Coord = {
    readonly space: string
    readonly values: Float32Array
    readonly conf: Float32Array
}

/** A signed, named gap on one axis. The readable half of a distance. */
export type Gap = {
    axis: string
    /** target minus current. Positive means the current position is short. */
    gap: number
}
