import { Space, coord, type Axis, type Coord, type SpaceHandle } from "../src/pure"
import { Rng } from "./rng"

/**
 * THE GENERATOR IS THE EXPERIMENT.
 *
 * Planting isotropic Gaussian clusters in an orthogonal space and recovering them
 * with a euclidean metric proves nothing — the data was built out of the metric's
 * own assumptions, so recovery is guaranteed at any size. Every knob below exists
 * to attack a specific claim the package makes, so that a passing number means
 * something:
 *
 *   zipf             unequal region sizes      → recall is not balanced-class luck
 *   bimodal          two-mode concepts         → Criterion P, and whether multi-prototype rescues it
 *   duplicates       axes correlated at r≈1    → "duplicates dominate rankings"
 *   heteroscedastic  tight and diffuse regions → a single global radius
 *   distractors      pure-noise axes           → "dead axes cost little"
 *   coverage         partial assessment        → the measured-intersection rule
 *   concentrate      signal in one domain      → per-domain combination helps rather than dilutes
 *
 * What it CANNOT test: whether human-named axes capture real structure. That is
 * the ontology question, and only a real corpus answers it.
 */
export type SynthOpts = {
    seed: number
    /** Signal-carrying axes. Distractors and duplicates are added on top. */
    axes: number
    /** How many domain groups the axes are split across. */
    domains: number
    /** Planted concepts. */
    regions: number
    /** Records to generate. */
    records: number
    /** Held-out probes per region, used as queries. */
    probesPerRegion?: number
    /**
     * DIFFICULTY, as member spread relative to how far apart regions actually are.
     *
     * Absolute noise is the wrong knob and the first run proved it: with 40 signal
     * axes, randomly placed centres sit so far apart that any sane sigma gives
     * recall@1 = 1.000 at every size, and the experiment measures nothing. A
     * ceiling is indistinguishable from a metric that works.
     *
     * So sigma is derived: `overlap x mean nearest-centre distance`. At 0 regions
     * are points; at ~0.6 members genuinely stray into neighbours and recall has
     * room to move; above ~1 the labels are noise.
     */
    overlap?: number
    /** Absolute sigma, overriding `overlap`. For reproducing an older run. */
    noise?: number

    /** Region size skew. 0 = uniform, 1 = classic Zipf, 2 = severe. */
    zipf?: number
    /** Fraction of regions that are two-mode, so their centroid lands in empty space. */
    bimodal?: number
    /** Axes appended that copy a signal axis (r ≈ 1). */
    duplicates?: number
    /** Where duplicates land. "same" puts them all in one domain; "spread" scatters them. */
    duplicatesIn?: "same" | "spread"
    /**
     * What the duplicates copy.
     *
     * "signal" duplicates a discriminating axis — which the first run showed is
     * HARMLESS, because duplicating signal adds signal. "distractor" duplicates a
     * pure-noise axis, which is the case that should actually hurt: it amplifies a
     * dimension that is irrelevant to every distinction, drowning out the axes
     * that carry the answer.
     */
    duplicateSource?: "signal" | "distractor"
    /** Pure-noise axes appended. */
    distractors?: number
    /** Spread of per-region noise multipliers, as a log-normal sigma. 0 = homoscedastic. */
    heteroscedastic?: number
    /** Fraction of axes measured per record. 1 = every axis assessed. */
    coverage?: number
    /**
     * HOW coverage is missing, which matters more than how much.
     *
     * "random" masks each axis independently — thin but even, so two records
     * overlap on roughly `coverage²` of the table.
     * "domain" masks whole domains, which is the realistic shape: a mechanical
     * producer fills one domain and a model fills another, so two records can
     * share *nothing* in a domain rather than a little of everything.
     */
    coverageMode?: "random" | "domain"
    /**
     * Fraction of records that get FULL coverage regardless of `coverage`.
     *
     * The realistic producer scenario, and the one a coverage floor exists for:
     * some records were assessed by every producer and some only by one, so the
     * store holds thick and thin rows competing in the same ranking. Uniform
     * thinness is a different problem — there is nothing to discriminate.
     */
    coverageMix?: number
    /**
     * Coverage for the held-out probes, separately.
     *
     * Defaults to 1: a query is a freshly assessed item, so the realistic
     * asymmetry is a fully-measured probe against a partially-measured store.
     */
    probeCoverage?: number
    /** Put all signal in domain 0 rather than spreading it across every domain. */
    concentrate?: boolean
}

export type SynthRecord = {
    id: string
    coord: Coord
    /** Ground truth. */
    region: number
}

export type Corpus = {
    space: SpaceHandle
    opts: Required<Omit<SynthOpts, "duplicatesIn" | "duplicateSource" | "coverageMode">> & {
        duplicatesIn: "same" | "spread"
        duplicateSource: "signal" | "distractor"
        coverageMode: "random" | "domain"
    }
    /** The sigma actually used, after deriving from `overlap`. Reported so a run is reproducible. */
    sigma: number
    records: SynthRecord[]
    probes: SynthRecord[]
    /** Planted modes per region — what a perfect prototype would recover. */
    modes: Coord[][]
    /** Axis names by role, for reporting. */
    roles: { signal: string[]; duplicate: string[]; distractor: string[] }
}

export function synth(opts: SynthOpts): Corpus {
    const full = defaults(opts)
    const rng = Rng(full.seed)
    const layout = axes(full)
    const space = Space({ axes: layout.axes })

    // Region centres, kept clear of the cube's faces so noise clips rarely.
    const modes: number[][][] = []
    for (let region = 0; region < full.regions; region++) {
        const primary = centre(rng, full, layout)
        const twoMode = rng.next() < full.bimodal
        modes.push(twoMode ? [primary, displaced(rng, primary, layout)] : [primary])
    }

    // Zipf weights, so region sizes are skewed rather than uniform.
    const weights = Array.from({ length: full.regions }, (_, i) => 1 / Math.pow(i + 1, full.zipf))

    // Sigma is derived from how far apart the centres actually landed, so the
    // task stays equally hard as the number of axes changes.
    const sigma = full.noise > 0 ? full.noise : full.overlap * separation(modes, layout)

    // Per-region noise multipliers — some concepts tight, some diffuse.
    const spread = Array.from({ length: full.regions }, () =>
        full.heteroscedastic === 0 ? 1 : Math.exp(rng.normal() * full.heteroscedastic)
    )

    const records: SynthRecord[] = []
    for (let i = 0; i < full.records; i++) {
        const region = rng.weighted(weights)
        // Thick or thin, decided per record.
        const thick = rng.next() < full.coverageMix
        records.push(
            sample(rng, space, full, layout, modes, spread, sigma, thick ? 1 : full.coverage, region, `r${i}`)
        )
    }

    const probes: SynthRecord[] = []
    for (let region = 0; region < full.regions; region++) {
        for (let i = 0; i < full.probesPerRegion; i++) {
            probes.push(sample(rng, space, full, layout, modes, spread, sigma, full.probeCoverage, region, `p${region}-${i}`))
        }
    }

    return {
        space: space,
        opts: full,
        sigma: sigma,
        records: records,
        probes: probes,
        modes: modes.map(group => group.map(mode => toCoord(space, full, layout, mode, 1, 1, Rng(1)))),
        roles: layout.roles,
    }
}

// ─── privates ─────────────────────────────────────────────────────────────────

type Layout = {
    axes: Axis[]
    /** Column indices carrying real signal. */
    signal: number[]
    /** duplicate column → the signal column it copies. */
    copies: Map<number, number>
    distractors: number[]
    /** Signal columns belonging to domain 0, when `concentrate` is set. */
    roles: { signal: string[]; duplicate: string[]; distractor: string[] }
}

function defaults(opts: SynthOpts) {
    return {
        seed: opts.seed,
        axes: opts.axes,
        domains: opts.domains,
        regions: opts.regions,
        records: opts.records,
        probesPerRegion: opts.probesPerRegion ?? 10,
        overlap: opts.overlap ?? 0.6,
        noise: opts.noise ?? 0,
        zipf: opts.zipf ?? 1,
        bimodal: opts.bimodal ?? 0.2,
        duplicates: opts.duplicates ?? 0,
        duplicatesIn: opts.duplicatesIn ?? ("same" as const),
        duplicateSource: opts.duplicateSource ?? ("signal" as const),
        distractors: opts.distractors ?? 0,
        heteroscedastic: opts.heteroscedastic ?? 0.3,
        coverage: opts.coverage ?? 1,
        coverageMode: opts.coverageMode ?? ("random" as const),
        coverageMix: opts.coverageMix ?? 0,
        probeCoverage: opts.probeCoverage ?? 1,
        concentrate: opts.concentrate ?? false,
    }
}

/** Build the axis table: signal axes spread over domains, then duplicates, then distractors. */
function axes(opts: ReturnType<typeof defaults>): Layout {
    const list: Axis[] = []
    const signal: number[] = []
    const copies = new Map<number, number>()
    const distractors: number[] = []
    const roles = { signal: [] as string[], duplicate: [] as string[], distractor: [] as string[] }

    for (let i = 0; i < opts.axes; i++) {
        const domain = `d${i % opts.domains}`
        const name = `${domain}:s${i}`
        list.push({ name: name, domain: domain, kind: "score", question: `synthetic signal ${i}` })
        signal.push(list.length - 1)
        roles.signal.push(name)
    }

    // Distractors before duplicates, so a duplicate can copy one.
    for (let i = 0; i < opts.distractors; i++) {
        const domain = `d${i % opts.domains}`
        const name = `${domain}:noise${i}`
        list.push({ name: name, domain: domain, kind: "score", question: `pure noise ${i}` })
        distractors.push(list.length - 1)
        roles.distractor.push(name)
    }

    const sources = opts.duplicateSource === "distractor" ? distractors : signal
    for (let i = 0; i < opts.duplicates; i++) {
        // "same" concentrates every duplicate in domain 0, which is the case
        // per-domain normalisation is supposed to absorb. "spread" scatters them,
        // which it cannot.
        const domain = opts.duplicatesIn === "same" ? "d0" : `d${i % opts.domains}`
        const name = `${domain}:dup${i}`
        const source = sources[i % Math.max(sources.length, 1)]
        if (source === undefined) break
        list.push({ name: name, domain: domain, kind: "score", question: `duplicate of ${list[source]!.name}` })
        copies.set(list.length - 1, source)
        roles.duplicate.push(name)
    }

    return { axes: list, signal: signal, copies: copies, distractors: distractors, roles: roles }
}

/** A region centre. With `concentrate`, only domain 0's signal axes vary; the rest sit at 0.5. */
function centre(rng: ReturnType<typeof Rng>, opts: ReturnType<typeof defaults>, layout: Layout): number[] {
    const values = new Array(layout.axes.length).fill(0.5)
    for (const column of layout.signal) {
        const inDomain0 = layout.axes[column]!.domain === "d0"
        values[column] = opts.concentrate && !inDomain0 ? 0.5 : rng.between(0.12, 0.88)
    }
    return values
}

/** A second mode, far enough that the two-mode centroid lands between them in empty space. */
function displaced(rng: ReturnType<typeof Rng>, from: readonly number[], layout: Layout): number[] {
    const values = [...from]
    for (const column of layout.signal) {
        const flip = from[column]! > 0.5 ? -1 : 1
        values[column] = clamp(from[column]! + flip * rng.between(0.4, 0.6))
    }
    return values
}

function sample(
    rng: ReturnType<typeof Rng>,
    space: SpaceHandle,
    opts: ReturnType<typeof defaults>,
    layout: Layout,
    modes: number[][][],
    spread: readonly number[],
    sigma: number,
    coverage: number,
    region: number,
    id: string
): SynthRecord {
    const group = modes[region]!
    const mode = group[rng.int(group.length)]!
    return {
        id: id,
        coord: toCoord(space, opts, layout, mode, sigma * spread[region]!, coverage, rng),
        region: region,
    }
}

/** Mode + noise → a coordinate, with duplicates copied, distractors randomised and coverage masked. */
function toCoord(
    space: SpaceHandle,
    opts: ReturnType<typeof defaults>,
    layout: Layout,
    mode: readonly number[],
    sigma: number,
    coverage: number,
    rng: ReturnType<typeof Rng>
): Coord {
    const values = new Array<number>(layout.axes.length).fill(0)

    for (const column of layout.signal) {
        values[column] = clamp(mode[column]! + rng.normal() * sigma)
    }
    for (const [column, source] of layout.copies) {
        // r ≈ 1 rather than exactly 1 — a perfect copy is easier to detect than
        // the realistic case of two axes asking almost the same question.
        values[column] = clamp(values[source]! + rng.normal() * sigma * 0.15)
    }
    for (const column of layout.distractors) {
        values[column] = rng.next()
    }

    // Which domains this record's producers covered. Decided once per record in
    // "domain" mode, so a whole group is present or absent together.
    const covered = new Set<string>()
    if (coverage < 1 && opts.coverageMode === "domain") {
        for (let d = 0; d < opts.domains; d++) {
            if (rng.next() <= coverage) covered.add(`d${d}`)
        }
        // A record nothing measured is not a record. Keep at least one domain, or
        // the corpus quietly fills with rows that can never be compared to
        // anything and the coverage sweep measures attrition instead of the metric.
        if (covered.size === 0) covered.add(`d${rng.int(opts.domains)}`)
    }

    const readings: [string, { value: number; confidence: number }][] = []
    for (let column = 0; column < layout.axes.length; column++) {
        if (coverage < 1) {
            if (opts.coverageMode === "domain") {
                if (!covered.has(layout.axes[column]!.domain)) continue
            } else if (rng.next() > coverage) continue
        }
        readings.push([layout.axes[column]!.name, { value: values[column]!, confidence: 1 }])
    }

    return coord(space, readings)
}

/**
 * Mean distance from each region to its nearest neighbour, over signal axes only.
 *
 * RMS rather than raw euclidean so the value is comparable across different axis
 * counts — which is the whole point: it lets one `overlap` setting mean the same
 * difficulty at 20 axes and at 120.
 */
function separation(modes: readonly number[][][], layout: Layout): number {
    let total = 0

    for (let a = 0; a < modes.length; a++) {
        let nearest = Number.POSITIVE_INFINITY
        for (let b = 0; b < modes.length; b++) {
            if (a === b) continue
            for (const modeA of modes[a]!) {
                for (const modeB of modes[b]!) {
                    let sum = 0
                    for (const column of layout.signal) {
                        const delta = modeA[column]! - modeB[column]!
                        sum += delta * delta
                    }
                    const rms = Math.sqrt(sum / layout.signal.length)
                    if (rms < nearest) nearest = rms
                }
            }
        }
        total += nearest
    }

    return total / modes.length
}

function clamp(value: number): number {
    if (value < 0) return 0
    if (value > 1) return 1
    return value
}
