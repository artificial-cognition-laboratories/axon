import { load, retrieve, round, table } from "./measure"
import { synth } from "./synth"

/**
 * E4 — does the metric hold when producers assess different axes?
 *
 * Partial coverage is not a corner case, it is the design's own intended shape:
 * a mechanical producer fills one domain and a model fills another, and appending
 * an axis is deliberately free precisely because old records carry `conf = 0` on
 * it. So **partial coverage is the normal state of a real store**, and nothing
 * has tested it.
 *
 * Two modes, because HOW coverage is missing should matter more than how much:
 *
 *   random   each axis masked independently — thin but even. Two records overlap
 *            on roughly coverage² of the table.
 *   domain   whole domains present or absent, which is the producer-shaped case.
 *            Two records can share *nothing* in a domain.
 *
 * Probes stay fully measured: a query is a freshly assessed item, so the realistic
 * asymmetry is a complete probe against an incomplete store.
 *
 * WHAT WOULD FORCE A CHANGE TO THE CORE: `conf` currently gates participation
 * (zero or non-zero) and never weights the contribution, so a distance over 4
 * shared axes and one over 40 are equally confident numbers sorted against each
 * other. If recall or margin degrades materially below ~50% overlap, the metric
 * needs `min(conf_a, conf_b)` weighting with normalisation by weight rather than
 * by count — before any real producer touches it.
 */
export type E4Row = {
    mode: string
    coverage: number
    recall1: number
    recall5: number
    /** Mean axes compared on both sides — the explanatory variable. */
    compared: number
    /** Fraction of live rows comparable to the probe at all. The rest were dropped. */
    ranked: number
    sameMean: number
    otherMean: number
    margin: number
}

const COVERAGE = [1, 0.75, 0.5, 0.35, 0.25]

export async function e4(opts: { seed?: number } = {}) {
    const seed = opts.seed ?? 23
    const rows: E4Row[] = []

    // The third arm is the architectural fix rather than a metric change: refuse to
    // rank a candidate measured on less than 80% of what the probe measured. Polls
    // of different sizes must not compete.
    const arms = [
        { mode: "uniform", coverageMode: "random", mix: 0, floor: 0 },
        { mode: "uniform+floor", coverageMode: "random", mix: 0, floor: 0.8 },
        { mode: "domain", coverageMode: "domain", mix: 0, floor: 0 },
        // Half the records fully assessed, half thin — the producer scenario.
        { mode: "mixed", coverageMode: "random", mix: 0.5, floor: 0 },
        { mode: "mixed+floor", coverageMode: "random", mix: 0.5, floor: 0.8 },
    ] as const

    for (const arm of arms) {
        const mode = arm.coverageMode
        for (const coverage of COVERAGE) {
            const corpus = synth({
                seed: seed,
                axes: 40,
                domains: 4,
                regions: 40,
                records: 8_000,
                probesPerRegion: 5,
                distractors: 8,
                coverage: coverage,
                coverageMode: mode,
                coverageMix: arm.mix,
                probeCoverage: 1,
                overlap: 1.0,
                zipf: 1,
                bimodal: 0.2,
                heteroscedastic: 0.3,
            })

            const loaded = await load(corpus)
            const result = await retrieve(loaded.locus, loaded.truth, corpus.probes, {
                corpus: corpus,
                minCompleteness: arm.floor,
            })
            await loaded.locus.close()

            rows.push({
                mode: arm.mode,
                coverage: coverage,
                recall1: round(result.recall1),
                recall5: round(result.recall5),
                compared: round(result.meanCompared, 1),
                ranked: round(result.rankedFraction),
                sameMean: round(result.sameMean),
                otherMean: round(result.otherMean),
                margin: round(result.margin),
            })

            console.log(
                `  ${arm.mode.padEnd(13)} cov=${String(coverage).padEnd(4)}  recall@1=${round(result.recall1)}  compared=${round(result.meanCompared, 1)}  ranked=${round(result.rankedFraction)}  margin=${round(result.margin)}`
            )
        }
    }

    return { name: "e4-coverage", rows: rows, markdown: table(rows) }
}
