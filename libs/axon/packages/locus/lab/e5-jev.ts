import { join } from "node:path"
import { Locus } from "../src"
import { Space, type Coord } from "../src/pure"
import { AXES, Corpus, Jev, Producer, QUERIES, type Message, openrouterKey } from "./jev"
import { round, table } from "./measure"
import { Rng } from "./rng"

/**
 * E5 — a first look at Jev as the producer: how well does it project real
 * messages, and real searches, into a manifest space?
 *
 * A SPOT CHECK, not a measurement. It shows what Jev does with the messages
 * people actually sent the agents in this repo, so a person can read the
 * results and judge; the measured experiments (paraphrase, counterfactual
 * edits, batch-mates) come after, aimed at whatever this shows.
 *
 * Four things, each printed to be read:
 *   axes        how each axis is used across the sample — one that never
 *               fires, or always does, is dead
 *   queries     each search: the axes it constrained, and the five nearest
 *               messages
 *   stability   ten messages labelled three more times, uncached: how far each
 *               axis moves, and whether their nearest neighbours survive
 *   cost        what it took
 *
 * Hits OpenRouter, so it is never part of `bun run lab` — only `bun run lab e5`.
 * Answers are cached under `lab/cache/jev`, so a re-run is free and reads the
 * same answers; stability always asks fresh.
 */

const MODEL = "typesafe/jev-1.13"
const SAMPLE = 200
const SEED = 5
const STABLE = { messages: 10, repeats: 3 }
/** How sure Jev must be that a search says something about an axis before that axis is measured on it. */
const RELEVANCE = 0.5
const ROOT = join(import.meta.dir, "../../../../..")

export async function e5() {
    const jev = Jev({ key: openrouterKey(ROOT), model: MODEL, cache: join(import.meta.dir, "cache/jev"), concurrency: 8 })
    const space = Space({ axes: AXES })
    const producer = Producer({ jev: jev, space: space, axes: AXES, relevance: RELEVANCE })
    const messages = Corpus({ root: ROOT, minLength: 40, maxLength: 2_000 }).sample(SAMPLE, Rng(SEED))
    console.log(`  labelling ${messages.length} messages, ${producer.domains.length} calls each`)

    const labelled = await Promise.all(messages.map(message => producer.label(message.text)))
    const locus = await Locus({ space: space, conn: { type: "memory" } })
    await locus.records.putMany(messages.map((message, i) => ({ id: message.id, coord: labelled[i]!.coord, at: message.at, payload: message })))

    const axes = AXES.map((axis, i) => {
        const values = labelled.map(one => one.coord.values[i]!)
        return {
            axis: axis.name,
            mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
            "share > 0.5": round(values.filter(value => value > 0.5).length / values.length),
            spread: round(Math.max(...values) - Math.min(...values)),
        }
    })

    console.log(`  searching ${QUERIES.length} queries`)
    const queries = await Promise.all(QUERIES.map(async query => {
        const projected = await producer.query(query.text)
        const hits = projected.coord ? (await locus.records.near(projected.coord, { limit: 5 })).hits : []
        return { query: query, projected: projected, hits: hits }
    }))

    console.log(`  relabelling ${STABLE.messages} messages ${STABLE.repeats} times, fresh`)
    const stability = await stable(messages.slice(0, STABLE.messages), labelled.slice(0, STABLE.messages).map(one => one.coord))

    const rows = queries.flatMap(({ query, hits }) => hits.map((hit, rank) => ({
        query: query.text,
        kind: query.kind,
        rank: rank + 1,
        distance: round(hit.distance!),
        compared: hit.compared!,
        agent: (hit.record.payload as Message).agent,
        message: snippet((hit.record.payload as Message).text),
    })))

    return {
        name: "e5-jev",
        rows: { axes: axes, queries: rows, stability: stability.rows, spent: jev.spent },
        markdown: [
            `${messages.length} messages sampled (seed ${SEED}) from every session under \`.agent/\`, labelled by \`${MODEL}\` — one call a domain. Spent: ${jev.spent.calls} fresh calls, $${round(jev.spent.usd, 4)}.`,
            `### Axes\n\nHow each axis is used across the sample. Near-zero spread, or a share pinned at 0 or 1, is a dead axis.\n\n${table(axes)}`,
            `### Queries\n\nEach search measures only the axes Jev judged it says something about (relevance ≥ ${RELEVANCE}); the rest stay unmeasured and take no part in the distance.\n\n${queries.map(({ query, projected, hits }) => [
                `#### "${query.text}" · ${query.kind}`,
                projected.assessed.length === 0
                    ? `Constrained nothing — no axis cleared ${RELEVANCE}. Most relevant: ${top(projected.relevance)}.`
                    : `Constrained: ${projected.assessed.map(one => `\`${one.axis}\` ${round(one.reading.value, 2)}`).join(", ")}`,
                hits.length > 0 ? table(hits.map((hit, rank) => ({
                    "#": rank + 1,
                    distance: round(hit.distance!),
                    agent: (hit.record.payload as Message).agent,
                    message: snippet((hit.record.payload as Message).text),
                }))) : "",
            ].join("\n\n")).join("\n\n")}`,
            `### Stability\n\n${STABLE.messages} messages, each labelled ${STABLE.repeats} more times without the cache. Drift is the most an axis moved across the four labellings. Neighbours is how many of a message's five nearest stay among the five nearest when a fresh labelling is the probe.\n\n${table(stability.rows)}\n\nNeighbours kept, mean over messages and repeats: **${stability.neighbours}** of 5.`,
        ].join("\n\n"),
    }

    async function stable(sample: readonly Message[], first: readonly Coord[]) {
        const drift = AXES.map(() => [] as number[])
        const kept: number[] = []
        for (const [m, message] of sample.entries()) {
            const original = await neighbours(first[m]!, message.id)
            const readings = [first[m]!]
            for (let r = 0; r < STABLE.repeats; r++) {
                const again = (await producer.label(message.text, true)).coord
                readings.push(again)
                const found = await neighbours(again, message.id)
                kept.push(found.filter(id => original.includes(id)).length)
            }
            AXES.forEach((_, i) => {
                const values = readings.map(one => one.values[i]!)
                drift[i]!.push(Math.max(...values) - Math.min(...values))
            })
        }
        return {
            rows: AXES.map((axis, i) => ({
                axis: axis.name,
                "mean drift": round(drift[i]!.reduce((sum, value) => sum + value, 0) / drift[i]!.length),
                "max drift": round(Math.max(...drift[i]!)),
            })),
            neighbours: round(kept.reduce((sum, value) => sum + value, 0) / kept.length, 2),
        }
    }

    /** The five nearest to a position, itself left out. */
    async function neighbours(position: Coord, self: string): Promise<string[]> {
        const { hits } = await locus.records.near(position, { limit: 6 })
        return hits.map(hit => hit.record.id).filter(id => id !== self).slice(0, 5)
    }
}


function snippet(text: string): string {
    return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 110)
}

function top(relevance: Readonly<Record<string, number>>): string {
    return Object.entries(relevance).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([axis, value]) => `\`${axis}\` ${round(value, 2)}`).join(", ")
}
