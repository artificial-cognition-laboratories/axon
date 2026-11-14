import { load, retrieve, round, table, type Retrieval } from "./measure"
import { synth } from "./synth"

/**
 * E1 — does the metric still discriminate as the corpus and the space grow?
 *
 * Sweeps records × axes on an adversarial corpus (skewed region sizes, two-mode
 * concepts, heteroscedastic spread, distractor axes) and reports recall@1 plus
 * distance CONCENTRATION.
 *
 * Concentration is the one to watch. Recall can hold up on an easy corpus while
 * every candidate quietly drifts toward the same distance; once concentration
 * approaches 0 the metric has stopped separating anything and every downstream
 * mechanism — kinds, novelty, region fitting — is running on noise.
 *
 * FAILS IF recall@1 collapses before ~1e5 at 100 axes. Then distance
 * concentration bites at working sizes, and domain weighting needs attention
 * before anything else in the package does.
 */
export type E1Row = {
    records: number
    axes: number
    domains: number
    recall1: number
    recall5: number
    mrr: number
    concentration: number
    sameMean: number
    otherMean: number
    margin: number
    loadMs: number
    queryMs: number
}

const RECORDS = [1_000, 5_000, 20_000, 50_000]
const AXES = [20, 60, 120]

export async function e1(opts: { records?: number[]; axes?: number[]; seed?: number } = {}) {
    const recordCounts = opts.records ?? RECORDS
    const axisCounts = opts.axes ?? AXES
    const seed = opts.seed ?? 1
    const rows: E1Row[] = []

    for (const axes of axisCounts) {
        for (const records of recordCounts) {
            // Domains scale with the space so each holds 5-15 axes — the range the
            // design claims keeps a metric meaningful.
            const domains = Math.max(2, Math.round(axes / 10))
            const corpus = synth({
                seed: seed,
                axes: axes,
                domains: domains,
                regions: 40,
                records: records,
                probesPerRegion: probes(records),
                distractors: Math.round(axes * 0.2),
                overlap: 1.0,
                zipf: 1,
                bimodal: 0.2,
                heteroscedastic: 0.3,
            })

            const loaded = await load(corpus)
            const result: Retrieval = await retrieve(loaded.locus, loaded.truth, corpus.probes, { corpus: corpus })
            await loaded.locus.close()

            rows.push({
                records: records,
                axes: axes + Math.round(axes * 0.2),
                domains: domains,
                recall1: round(result.recall1),
                recall5: round(result.recall5),
                mrr: round(result.mrr),
                concentration: round(result.concentration),
                sameMean: round(result.sameMean),
                otherMean: round(result.otherMean),
                margin: round(result.margin),
                loadMs: Math.round(loaded.ms),
                queryMs: Math.round(result.ms.query),
            })

            console.log(
                `  axes=${axes} records=${records}  recall@1=${round(result.recall1)}  conc=${round(result.concentration)}  ${Math.round(result.ms.query)}ms/${result.probes} probes`
            )
        }
    }

    return { name: "e1-scale", rows: rows, markdown: table(rows) }
}

/** Fewer probes as N grows — ranking is O(N·D) per probe, and the bench should finish. */
function probes(records: number): number {
    if (records <= 5_000) return 6
    if (records <= 20_000) return 3
    return 2
}
