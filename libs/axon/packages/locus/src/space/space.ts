import { Axes } from "./axes"
import { Domains } from "./domains"
import { Candidates } from "./candidates"
import { fingerprint } from "./version"
import type { SpaceOpts } from "./types"

/**
 * THE BASIS — the manifest coordinate system every position in this memory is
 * expressed in.
 *
 * Manifest, not latent: the dimensions are specified and named in advance
 * rather than emerging from training. That single property is what buys
 * predicate queries, readable explanations and consolidation by arithmetic —
 * all of which an opaque embedding cannot offer.
 *
 * Pure. No IO, no network, no clock. A Space can be built in a test with two
 * axes and compared against a stored one without anything being open.
 */
export function Space(opts: SpaceOpts) {
    const axes = Axes({ axes: opts.axes })
    const domains = Domains({ axes: axes, overrides: opts.domains })
    const candidates = Candidates({ candidates: opts.candidates })
    const version = fingerprint(opts.axes)

    return {
        version: version,
        axes: axes,
        domains: domains,
        candidates: candidates,
    }
}

export type SpaceHandle = ReturnType<typeof Space>
