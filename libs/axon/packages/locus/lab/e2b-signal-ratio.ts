import { load, retrieve, round, table } from "./measure"
import { synth } from "./synth"

/**
 * E2b — where does robustness to irrelevant axes END?
 *
 * E2 found no effect from duplicating axes, at any count or arrangement. The
 * reason turned out to be that the corpus had 40 independently discriminating
 * axes: that is an error-correcting code, and adding noise to a code with forty
 * votes does not change the outcome.
 *
 * Which means the variable was never the number of duplicates. It is **the ratio
 * of discriminating axes to irrelevant ones** — and the regime that should hurt
 * is FEW discriminating axes, which is the realistic case for a hand-authored
 * space where one specific question turns on two or three axes out of sixty.
 *
 * `overlap` is lowered to 0.6 so every configuration starts with a high baseline
 * and has room to fall. Deltas are against each row's own zero-duplicate
 * baseline, so a low-dimensional config is compared against itself.
 */
export type E2bRow = {
    signal: number
    duplicates: number
    recall1: number
    delta: number
    concentration: number
    sameMean: number
    otherMean: number
    margin: number
}

const SIGNAL = [3, 6, 12, 40]
const DUPLICATES = [0, 8, 24]

export async function e2b(opts: { seed?: number } = {}) {
    const seed = opts.seed ?? 11
    const rows: E2bRow[] = []

    for (const signal of SIGNAL) {
        let baseline = 0

        for (const duplicates of DUPLICATES) {
            const corpus = synth({
                seed: seed,
                axes: signal,
                // One domain, so nothing is averaged away across groups. The
                // harshest arrangement, deliberately.
                domains: 1,
                regions: 12,
                records: 8_000,
                probesPerRegion: 30,
                distractors: 8,
                duplicates: duplicates,
                duplicatesIn: "same",
                duplicateSource: "distractor",
                overlap: 0.6,
                zipf: 1,
                bimodal: 0.2,
                heteroscedastic: 0.3,
            })

            const loaded = await load(corpus)
            const result = await retrieve(loaded.locus, loaded.truth, corpus.probes, { corpus: corpus })
            await loaded.locus.close()

            if (duplicates === 0) baseline = result.recall1

            rows.push({
                signal: signal,
                duplicates: duplicates,
                recall1: round(result.recall1),
                delta: round(result.recall1 - baseline),
                concentration: round(result.concentration),
                sameMean: round(result.sameMean),
                otherMean: round(result.otherMean),
                margin: round(result.margin),
            })

            console.log(
                `  signal=${String(signal).padStart(2)} dup=${String(duplicates).padStart(2)}  recall@1=${round(result.recall1)}  delta=${round(result.recall1 - baseline)}  margin=${round(result.margin)}`
            )
        }
    }

    return { name: "e2b-signal-ratio", rows: rows, markdown: table(rows) }
}
