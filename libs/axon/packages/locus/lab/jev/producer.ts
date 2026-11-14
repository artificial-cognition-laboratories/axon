import { coord, type Axis, type Coord, type Reading, type SpaceHandle } from "../../src/pure"
import type { Answer, JevHandle, Question } from "./jev"

/** One axis, as Jev answered it: the reading locus stores, and Jev's own confidence where it gave one. */
export type Assessed = { axis: string; reading: Reading; jevConfidence: number | null }

/**
 * Producer — Jev as the producer of coordinates in a space. Two jobs, asked
 * differently because they ARE different:
 *
 *   label   a message is a situation. Every axis is asked of it, one call per
 *           domain, and every axis comes back measured.
 *   query   a search is not a situation — "auth system" says nothing about
 *           mood. So each axis is asked twice: does the search say anything
 *           about it, and if so, what. An axis it says nothing about stays
 *           UNMEASURED, so it takes no part in the distance, rather than a
 *           forced guess that pulls every result toward the middle.
 *
 * Jev's confidence is kept beside the reading, not as locus's `conf`: locus
 * gates on `conf` (zero or not) and never weights by it, so a measured axis is
 * stored at 1, and whether Jev's confidence predicts its error is measured
 * separately.
 */
export function Producer(opts: { jev: JevHandle; space: SpaceHandle; axes: readonly Axis[]; relevance: number }) {
    const domains = [...new Set(opts.axes.map(axis => axis.domain))]

    return {
        domains: domains,

        /** Every axis of a message, one call a domain. */
        async label(text: string, fresh = false): Promise<{ coord: Coord; assessed: Assessed[] }> {
            const assessed = (await Promise.all(domains.map(async domain => {
                const axes = opts.axes.filter(axis => axis.domain === domain)
                const questions = Object.fromEntries(axes.map(axis => [axis.name, question(axis)]))
                const answers = await opts.jev.decide({ message: text }, questions, fresh)
                return axes.map(axis => reading(axis, answers[axis.name]!))
            }))).flat()
            return { coord: coord(opts.space, assessed.map(one => [one.axis, one.reading] as const)), assessed: assessed }
        },

        /** The axes a search constrains, and only those, measured as the messages it is looking for. */
        async query(text: string): Promise<{ coord: Coord | null; assessed: Assessed[]; relevance: Record<string, number> }> {
            const state = { search: text, note: "A person is searching their past messages to a coding agent. Answer about the messages this search is looking for." }
            const relevance: Record<string, number> = {}
            const assessed = (await Promise.all(domains.map(async domain => {
                const axes = opts.axes.filter(axis => axis.domain === domain)
                const questions: Record<string, Question> = {}
                for (const axis of axes) {
                    questions[`about:${axis.name}`] = { type: "noul", instructions: `The search says something about this, either way: ${axis.question}` }
                    questions[axis.name] = question(axis)
                }
                const answers = await opts.jev.decide(state, questions)
                return axes.flatMap(axis => {
                    const about = answers[`about:${axis.name}`]!
                    if (about.type !== "noul") throw new Error(`jev answered about:${axis.name} as a ${about.type}`)
                    relevance[axis.name] = about.noul
                    return about.noul >= opts.relevance ? [reading(axis, answers[axis.name]!)] : []
                })
            }))).flat()
            return {
                coord: assessed.length > 0 ? coord(opts.space, assessed.map(one => [one.axis, one.reading] as const)) : null,
                assessed: assessed,
                relevance: relevance,
            }
        },
    }
}

export type ProducerHandle = ReturnType<typeof Producer>

/** An axis, as a question to Jev. */
function question(axis: Axis): Question {
    if (axis.kind === "noul") return { type: "noul", instructions: axis.question }
    return { type: "score", instructions: axis.question, criteria: axis.levels! }
}

/** Jev's answer, as a reading in [0,1]: a noul is its probability; a score its expected level over the scale. */
function reading(axis: Axis, answer: Answer): Assessed {
    if (answer.type === "choice" || answer.type !== axis.kind) throw new Error(`jev answered ${axis.name} as a ${answer.type}, not a ${axis.kind}`)
    if (answer.type === "noul") return { axis: axis.name, reading: { value: clamp(answer.noul), confidence: 1 }, jevConfidence: null }
    const top = axis.levels!.length - 1
    return { axis: axis.name, reading: { value: clamp(answer.score / top), confidence: 1 }, jevConfidence: answer.confidence }
}

function clamp(value: number): number {
    return Math.min(1, Math.max(0, value))
}
