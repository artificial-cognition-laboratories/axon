import { join } from "node:path"
import { Atoms, Jev, Projects, type Atom, type Question, type Speaker, openrouterKey } from "./jev"
import { round, table } from "./measure"
import { Rng } from "./rng"

/**
 * E6 — linking: can Jev say which project an atom of a session is about?
 *
 * Linking is what the whole memory stands on: an atom tied to the wrong
 * entity is a belief about the wrong thing. The entities here are the repo's
 * own projects (~100), found mechanically, and the question is one `choice`
 * over all of them plus `none`.
 *
 * GROUND TRUTH, FOR FREE: an atom that names a project's path or package says
 * which project it concerns. Those names are HIDDEN before Jev sees the atom,
 * so what is measured is linking from what the atom says, not from the name it
 * carries. That is the hard case — in a real session the name is often there,
 * and the mechanical step links it exactly.
 *
 * Two conditions, because an atom alone is often a fragment:
 *   alone     just the atom
 *   context   the atom, with the three atoms before it in its session
 *
 * And a spot check: atoms that name nothing, linked with context, printed to
 * be read — whether Jev links them, and to what, is a judgement.
 *
 * Only `bun run lab e6`: it calls OpenRouter. Answers are cached.
 */

const MODEL = "typesafe/jev-1.13"
const SEED = 6
/** Per speaker, so the person, the agent's prose and its actions are measured alike. */
const PER_SPEAKER = 50
/** At most this many truth atoms from one project, so the two busiest projects do not decide the score. */
const PER_PROJECT = 6
const SPOT = 30
const BEFORE = 3
/** An atom whose masked text says less than this is unrecoverable from content, not a linking failure. */
const LEFT = 25
const ROOT = join(import.meta.dir, "../../../../..")
const NONE = "none"

export async function e6() {
    const jev = Jev({ key: openrouterKey(ROOT), model: MODEL, cache: join(import.meta.dir, "cache/jev"), concurrency: 8 })
    const projects = Projects({ root: ROOT })
    const sessions = Atoms({ root: ROOT, minLength: 25, maxLength: 800 }).sessions()
    const rng = Rng(SEED)
    console.log(`  ${projects.all.length} projects, ${sessions.length} sessions, ${sessions.flat().length} atoms`)

    const question: Question = {
        type: "choice",
        instructions: "Which project in this code repository is this part of a coding session about?",
        criteria: {
            ...Object.fromEntries(projects.all.map(project => [project.key, `${project.name}${project.description ? ` — ${project.description}` : ""}`])),
            [NONE]: "None of these: it concerns no particular project, or the repository as a whole",
        },
    }

    const truths = sampled()
    console.log(`  linking ${truths.length} atoms with a known project, alone and in context; ${SPOT} with none`)

    const linked = await Promise.all(truths.map(async ({ atom, truth, session }) => {
        const [alone, context] = await Promise.all([
            jev.decide({ atom: projects.mask(atom.text) }, { link: question }),
            jev.decide({ before: before(session, atom).map(projects.mask), atom: projects.mask(atom.text) }, { link: question }),
        ])
        return { atom: atom, truth: truth, alone: ranked(alone.link!), context: ranked(context.link!) }
    }))

    const spot = await Promise.all(unnamed().map(async ({ atom, session }) => {
        const answer = await jev.decide({ before: before(session, atom), atom: atom.text }, { link: question })
        return { atom: atom, ranked: ranked(answer.link!) }
    }))

    const scores = (["person", "agent", "action", "all"] as const).flatMap(speaker => (["alone", "context"] as const).map(condition => {
        const rows = linked.filter(one => speaker === "all" || one.atom.speaker === speaker)
        const at = (k: number) => rows.filter(one => one[condition].slice(0, k).some(([project]) => project === one.truth)).length / rows.length
        return {
            speaker: speaker,
            condition: condition,
            atoms: rows.length,
            "top 1": round(at(1)),
            "top 3": round(at(3)),
            "said none": round(rows.filter(one => one[condition][0]![0] === NONE).length / rows.length),
            "mean p(top)": round(rows.reduce((sum, one) => sum + one[condition][0]![1], 0) / rows.length),
        }
    }))

    const calibration = [0, 0.5, 0.8, 0.95].map((floor, i, floors) => {
        const ceiling = floors[i + 1] ?? 1.01
        const rows = linked.filter(one => one.context[0]![1] >= floor && one.context[0]![1] < ceiling)
        return {
            "p(top)": `${floor}–${ceiling > 1 ? 1 : ceiling}`,
            atoms: rows.length,
            "right": rows.length ? round(rows.filter(one => one.context[0]![0] === one.truth).length / rows.length) : "—",
        }
    })

    const misses = linked.filter(one => one.context[0]![0] !== one.truth).slice(0, 15).map(one => ({
        speaker: one.atom.speaker,
        truth: one.truth,
        "jev said": `${one.context[0]![0]} ${round(one.context[0]![1], 2)}`,
        atom: snippet(projects.mask(one.atom.text)),
    }))

    return {
        name: "e6-linking",
        rows: { scores: scores, calibration: calibration, linked: linked.map(one => ({ ...one, atom: { ...one.atom, text: projects.mask(one.atom.text) } })), spot: spot, spent: jev.spent },
        markdown: [
            `${projects.all.length} projects as entities; ${linked.length} atoms whose project is known from a name they carry — hidden before Jev reads them. One \`choice\` over every project plus \`none\`. \`${MODEL}\`, seed ${SEED}. Spent: ${jev.spent.calls} fresh calls, $${round(jev.spent.usd, 4)}.`,
            `### Linking, by who said it\n\n${table(scores)}`,
            `### Does its confidence mean anything?\n\nWith context: how often Jev's top project was right, by how sure it was.\n\n${table(calibration)}`,
            `### Misses, with context\n\nThe first fifteen. \`[path]\` and \`[package]\` are the hidden names.\n\n${table(misses)}`,
            `### Atoms that name no project\n\nWith context. Whether these should link, and to what, is a judgement — read them.\n\n${table(spot.map(({ atom, ranked }) => ({
                speaker: atom.speaker,
                "jev said": ranked.slice(0, 2).map(([project, p]) => `${project} ${round(p, 2)}`).join(" · "),
                atom: snippet(atom.text),
            })))}`,
        ].join("\n\n"),
    }

    /** Truth atoms: enough per speaker, no project over-represented, and something left once names are hidden. */
    function sampled(): Array<{ atom: Atom; truth: string; session: Atom[] }> {
        const candidates = shuffled(sessions.flatMap(session => session.map(atom => ({ atom: atom, truth: projects.mention(atom.text), session: session }))))
            .filter((one): one is { atom: Atom; truth: string; session: Atom[] } => one.truth !== null && left(projects.mask(one.atom.text)) >= LEFT)
        const taken = new Map<string, number>()
        const chosen: Array<{ atom: Atom; truth: string; session: Atom[] }> = []
        for (const speaker of ["person", "agent", "action"] as Speaker[]) {
            let count = 0
            for (const one of candidates) {
                if (count >= PER_SPEAKER) break
                if (one.atom.speaker !== speaker || (taken.get(one.truth) ?? 0) >= PER_PROJECT) continue
                taken.set(one.truth, (taken.get(one.truth) ?? 0) + 1)
                chosen.push(one)
                count++
            }
        }
        return chosen
    }

    /** Atoms from the person and the agent's prose that name no project. */
    function unnamed(): Array<{ atom: Atom; session: Atom[] }> {
        return shuffled(sessions.flatMap(session => session.map(atom => ({ atom: atom, session: session }))))
            .filter(one => one.atom.speaker !== "action" && projects.mention(one.atom.text) === null && one.atom.text.length >= 60)
            .slice(0, SPOT)
    }

    function before(session: Atom[], atom: Atom): string[] {
        return session.slice(Math.max(0, atom.index - BEFORE), atom.index).map(one => one.text)
    }

    function shuffled<T>(items: T[]): T[] {
        const copy = [...items]
        for (let i = copy.length - 1; i > 0; i--) {
            const j = rng.int(i + 1)
            ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
        }
        return copy
    }
}

/** A choice's options, most likely first. */
function ranked(answer: { type: string; probabilities?: Record<string, number> }): Array<[string, number]> {
    if (answer.type !== "choice" || !answer.probabilities) throw new Error(`jev answered the link as a ${answer.type}`)
    return Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])
}

/** How much an atom still says once its names are hidden. */
function left(masked: string): number {
    return masked.replace(/\[(path|package)\]/g, "").replace(/[^\w]/g, "").length
}


function snippet(text: string): string {
    return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 110)
}
