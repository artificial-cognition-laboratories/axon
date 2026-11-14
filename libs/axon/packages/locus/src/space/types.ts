/** How a producer is asked for an axis, and therefore what its value means. */
export type AxisKind =
    /** A yes/no proposition. The value is P(statement is true). */
    | "noul"
    /** A graded rubric over ordered levels. The value is the position on it. */
    | "score"

/**
 * One named dimension. The axis table IS the ontology — everything else in
 * this package is mechanism over it.
 *
 * `question` is load-bearing, not documentation: it is how a producer is asked
 * for this axis, so changing it changes what the axis MEANS and every
 * coordinate already stored was measured against the old wording. That is why
 * it is part of the basis fingerprint and `weight` is not.
 */
export type Axis = {
    name: string
    /** The group distance is computed within. Derived into a Domain. */
    domain: string
    kind: AxisKind
    /** Ordered levels for a `score` axis, lowest first. */
    levels?: readonly string[]
    question: string
}

/** How two positions are compared inside one domain. */
export type Metric =
    /** Straight-line distance, normalised to [0,1]. Magnitude matters. */
    | "euclidean"
    /** Angle only. Two positions with the same ratios are identical. */
    | "cosine"

/**
 * A group of axes compared together.
 *
 * Domains exist for three independent reasons that all want the same
 * structure: hand-authored axes are never orthogonal, so counting one concept
 * four times must not quadruple its influence; magnitude matters for some
 * questions and not others, so the metric belongs per group; and in high
 * dimensions all distances converge, so distance is only ever computed within
 * a small group and then combined.
 *
 * `weight` and `metric` are query-time, never stored — which is why changing
 * either is not a basis change.
 */
export type Domain = {
    name: string
    weight: number
    metric: Metric
}

/** A candidate axis: proposed, measured, deliberately NOT part of the basis. */
export type Candidate = {
    axis: Axis
    /** How many records have been assessed against it. */
    samples: number
    /** Mean value across those samples — an axis that never fires, or always does, is dead. */
    mean: number
    /** Highest absolute correlation with any adopted axis. Near 1 means duplicate. */
    redundancy: number
}

export type SpaceOpts = {
    axes: readonly Axis[]
    /** Per-domain overrides. Domains are derived from the axes; this only tunes them. */
    domains?: Readonly<Record<string, Partial<Omit<Domain, "name">>>>
    candidates?: readonly Candidate[]
}
