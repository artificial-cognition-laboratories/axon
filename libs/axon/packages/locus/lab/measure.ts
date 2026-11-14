import { Locus, type LocusHandle } from "../src"
import { distance, explain, type SpaceHandle } from "../src/pure"
import { Rng } from "./rng"
import type { Corpus, SynthRecord } from "./synth"

export type Retrieval = {
    /** Fraction of probes whose planted region came back first. */
    recall1: number
    recall5: number
    /** Mean reciprocal rank of the first correct hit. */
    mrr: number
    /**
     * Distance concentration: `(mean - min) / mean` over a RANDOM SAMPLE of the
     * corpus, not over the returned hits.
     *
     * The direct measurement of the curse of dimensionality. As dimensions grow,
     * every point drifts toward the same distance from every other and this tends
     * to 0 — at which point the metric has stopped separating anything, no matter
     * what recall says on an easy corpus.
     *
     * Measured against a random sample on purpose: computing it over the top-5
     * measures almost nothing, because those are all close by construction.
     */
    concentration: number
    /**
     * Mean ABSOLUTE distance from a probe to a random slice of the corpus.
     *
     * Recorded because `recall@1` is a RANK statistic and `Region.radius` is an
     * absolute threshold. Ranking can be perfectly stable while the distance
     * distribution slides — and if it slides, every radius calibrated on the old
     * axis table silently claims too much or too little, which breaks novelty
     * detection quietly rather than loudly.
     */
    meanAbs: number
    /** Mean absolute distance from a probe to members of its OWN region. What a radius is really calibrated against. */
    sameMean: number
    /** Mean absolute distance to members of other regions. */
    otherMean: number
    /** `otherMean - sameMean`. The separation a threshold has to sit inside. */
    margin: number
    /**
     * Mean number of axes compared on both sides.
     *
     * The explanatory variable for coverage: a distance over 4 shared axes and one
     * over 40 both land in [0,1] with nothing to mark which is the thinner claim.
     */
    meanCompared: number
    /** Fraction of live rows that were comparable to the probe at all. The rest were dropped, not ranked last. */
    rankedFraction: number
    probes: number
    candidates: number
    ms: { load: number; query: number }
}

/** Load a corpus into a memory-backed Locus. Returns the store plus the id→region truth map. */
export async function load(corpus: Corpus): Promise<{ locus: LocusHandle; truth: Map<string, number>; ms: number }> {
    const started = Bun.nanoseconds()
    const locus = await Locus({ space: corpus.space, conn: { type: "memory" } })
    const truth = new Map<string, number>()

    // Batched: per-record inserts made a 50k load 4.6s, which put a million out of reach.
    for (let i = 0; i < corpus.records.length; i += 5_000) {
        const slice = corpus.records.slice(i, i + 5_000)
        await locus.records.putMany(slice.map(record => ({ id: record.id, coord: record.coord })))
        for (const record of slice) truth.set(record.id, record.region)
    }

    return { locus: locus, truth: truth, ms: (Bun.nanoseconds() - started) / 1e6 }
}

/**
 * Query every probe and score the ranking against ground truth.
 *
 * `recall@1` asks the only question that matters for identity: did the nearest
 * stored thing come from the same planted concept? Everything else in this
 * package — kinds, novelty, region fitting — degrades from here.
 */
export async function retrieve(
    locus: LocusHandle,
    truth: Map<string, number>,
    probes: readonly SynthRecord[],
    opts: { limit?: number; corpus?: Corpus; sample?: number; minCompleteness?: number } = {}
): Promise<Retrieval> {
    const limit = opts.limit ?? 5
    const sample = opts.corpus ? pick(opts.corpus, opts.sample ?? 256) : []
    const started = Bun.nanoseconds()
    let absSum = 0
    let sameSum = 0
    let sameCount = 0
    let otherSum = 0
    let otherCount = 0
    let comparedSum = 0
    let comparedN = 0
    let rankedSum = 0

    let hit1 = 0
    let hit5 = 0
    let rrSum = 0
    let concentrationSum = 0
    let ranked = 0

    for (const probe of probes) {
        const result = await locus.records.near(probe.coord, {
            limit: limit,
            ...(opts.minCompleteness !== undefined ? { minCompleteness: opts.minCompleteness } : {}),
        })
        const labels = result.hits.map(hit => truth.get(hit.record.id))
        ranked = result.plan.ranked
        rankedSum += result.plan.ranked

        if (labels[0] === probe.region) hit1++
        const first = labels.indexOf(probe.region)
        if (first >= 0 && first < 5) hit5++
        if (first >= 0) rrSum += 1 / (first + 1)

        if (sample.length > 0) {
            const space = opts.corpus!.space
            const scan = scanSample(space, probe, sample)
            concentrationSum += scan.concentration
            absSum += scan.mean
            sameSum += scan.sameSum
            sameCount += scan.sameCount
            otherSum += scan.otherSum
            otherCount += scan.otherCount
            comparedSum += scan.comparedSum
            comparedN += scan.comparedN
        }
    }

    const sameMean = sameCount === 0 ? 0 : sameSum / sameCount
    const otherMean = otherCount === 0 ? 0 : otherSum / otherCount

    return {
        recall1: hit1 / probes.length,
        recall5: hit5 / probes.length,
        mrr: rrSum / probes.length,
        concentration: concentrationSum / probes.length,
        meanAbs: absSum / probes.length,
        sameMean: sameMean,
        otherMean: otherMean,
        margin: otherMean - sameMean,
        meanCompared: comparedN === 0 ? 0 : comparedSum / comparedN,
        rankedFraction: locus.records.count === 0 ? 0 : rankedSum / probes.length / locus.records.count,
        probes: probes.length,
        candidates: ranked,
        ms: { load: 0, query: (Bun.nanoseconds() - started) / 1e6 },
    }
}

/** One pass from a probe over the sample, collecting every absolute-scale statistic at once. */
function scanSample(space: SpaceHandle, probe: SynthRecord, sample: readonly SynthRecord[]) {
    let sum = 0
    let min = Number.POSITIVE_INFINITY
    let sameSum = 0
    let sameCount = 0
    let otherSum = 0
    let otherCount = 0
    let comparedSum = 0
    let comparedN = 0

    for (const other of sample) {
        const detail = explain(space, probe.coord, other.coord)
        // Uncomparable pairs contribute to neither distance nor the compared mean —
        // a distance that does not exist must not be averaged in as a number.
        if (detail.compared === 0) continue
        comparedSum += detail.compared
        comparedN++
        const d = detail.distance
        sum += d
        if (d < min) min = d
        if (other.region === probe.region) {
            sameSum += d
            sameCount++
        } else {
            otherSum += d
            otherCount++
        }
    }

    const mean = comparedN === 0 ? 0 : sum / comparedN
    return {
        mean: mean,
        concentration: mean === 0 ? 0 : (mean - min) / mean,
        sameSum: sameSum,
        sameCount: sameCount,
        otherSum: otherSum,
        otherCount: otherCount,
        comparedSum: comparedSum,
        comparedN: comparedN,
    }
}

/** A deterministic random slice of the corpus, labels kept so same/other distances can be split. */
function pick(corpus: Corpus, count: number): SynthRecord[] {
    const rng = Rng(99)
    const out: SynthRecord[] = []
    for (let i = 0; i < Math.min(count, corpus.records.length); i++) {
        out.push(corpus.records[rng.int(corpus.records.length)]!)
    }
    return out
}

/** Pretty-print a fixed-width table so results are readable in a terminal and in committed markdown. */
export function table(rows: readonly Record<string, string | number>[]): string {
    if (rows.length === 0) return ""
    const columns = Object.keys(rows[0]!)
    const width = (column: string) =>
        Math.max(column.length, ...rows.map(row => String(row[column] ?? "").length))

    const header = `| ${columns.map(c => c.padEnd(width(c))).join(" | ")} |`
    const rule = `| ${columns.map(c => "-".repeat(width(c))).join(" | ")} |`
    const body = rows.map(row => `| ${columns.map(c => String(row[c] ?? "").padEnd(width(c))).join(" | ")} |`)

    return [header, rule, ...body].join("\n")
}

export function round(value: number, places = 3): number {
    const scale = 10 ** places
    return Math.round(value * scale) / scale
}
