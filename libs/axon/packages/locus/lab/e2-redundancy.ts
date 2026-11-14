import { load, retrieve, round, table } from "./measure"
import { synth } from "./synth"

/**
 * E2 — what does a duplicate axis actually cost, and do domains absorb it?
 *
 * The first run answered the original question and the answer was NO EFFECT,
 * which was informative: duplicating a *discriminating* axis adds signal, not
 * noise, so it cannot hurt retrieval. The claim "duplicates dominate rankings"
 * was underspecified.
 *
 * The sharpened hypothesis: a duplicate is harmful only when it amplifies a
 * dimension that is IRRELEVANT to the distinction being drawn — then it drowns
 * out the axes carrying the answer. Three arms:
 *
 *   signal/same       duplicate a discriminating axis, all in one domain
 *   signal/spread     duplicate a discriminating axis, scattered across domains
 *   distractor/spread duplicate a PURE-NOISE axis, scattered across domains
 *
 * If the third degrades and the first two do not, then redundancy per se is
 * harmless and what matters is redundancy in *useless* axes — which makes
 * `stats.axes()` (variance, fill) the primary instrument and
 * `stats.correlations()` secondary.
 *
 * 400 probes for power: at recall ~0.9 the standard error is ~0.015, so effects
 * smaller than about 4 points are not detectable. The first run used 160 and
 * could not have seen anything below 7.
 */
export type E2Row = {
    arm: string
    duplicates: number
    recall1: number
    recall5: number
    mrr: number
    concentration: number
    /** Mean absolute distance to own-region members — what a Region radius is calibrated against. */
    sameMean: number
    /** `otherMean - sameMean`: the separation a threshold has to sit inside. */
    margin: number
    /** Recall lost against this arm's own zero-duplicate baseline. */
    delta: number
}

const DUPLICATES = [0, 2, 8, 24]

/**
 * The single-domain arms are the CONTROL, added after two runs found no effect at
 * all. Per-domain normalisation divides by the number of axes compared in that
 * domain, and combining domains averages them — both of which suppress
 * independent noise. Without a one-domain arm there is nothing to attribute a
 * null result to.
 */
const ARMS = [
    { arm: "signal/4dom", source: "signal", place: "spread", domains: 4, distractors: 8 },
    { arm: "distractor/4dom", source: "distractor", place: "spread", domains: 4, distractors: 8 },
    { arm: "signal/1dom", source: "signal", place: "same", domains: 1, distractors: 8 },
    { arm: "distractor/1dom", source: "distractor", place: "same", domains: 1, distractors: 8 },
] as const

export async function e2(opts: { duplicates?: number[]; seed?: number } = {}) {
    const counts = opts.duplicates ?? DUPLICATES
    const seed = opts.seed ?? 7
    const rows: E2Row[] = []

    for (const arm of ARMS) {
        let baseline = 0

        for (const duplicates of counts) {
            const corpus = synth({
                seed: seed,
                axes: 40,
                domains: arm.domains,
                regions: 40,
                records: 10_000,
                probesPerRegion: 10,
                distractors: arm.distractors,
                duplicates: duplicates,
                duplicatesIn: arm.place,
                duplicateSource: arm.source,
                overlap: 1.0,
                zipf: 1,
                bimodal: 0.2,
                heteroscedastic: 0.3,
            })

            const loaded = await load(corpus)
            const result = await retrieve(loaded.locus, loaded.truth, corpus.probes, { corpus: corpus })
            await loaded.locus.close()

            if (duplicates === 0) baseline = result.recall1

            rows.push({
                arm: arm.arm,
                duplicates: duplicates,
                recall1: round(result.recall1),
                recall5: round(result.recall5),
                mrr: round(result.mrr),
                concentration: round(result.concentration),
                sameMean: round(result.sameMean),
                margin: round(result.margin),
                delta: round(result.recall1 - baseline),
            })

            console.log(
                `  ${arm.arm.padEnd(18)} dup=${String(duplicates).padStart(2)}  recall@1=${round(result.recall1)}  delta=${round(result.recall1 - baseline)}  sameMean=${round(result.sameMean)}`
            )
        }
    }

    return { name: "e2-redundancy", rows: rows, markdown: table(rows) }
}
