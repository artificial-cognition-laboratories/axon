import type { Candidate } from "./types"

/**
 * Proposed axes that are NOT part of the space.
 *
 * The split exists because a basis whose dimensions drift continuously cannot
 * accumulate comparable history, and comparable history is the entire point of
 * the store. So proposal is cheap and unbounded; ADOPTION is a deliberate,
 * batched version change.
 *
 * What promotion policy reads these numbers is deliberately unwritten. It needs
 * a corpus that does not exist yet, and a promotion rule with no data behind it
 * is a line of roadmap pretending to be a line of code. The mechanism is here;
 * the judgement is not.
 */
export function Candidates(opts: { candidates?: readonly Candidate[] }) {
    const table = new Map<string, Candidate>()
    for (const candidate of opts.candidates ?? []) table.set(candidate.axis.name, candidate)

    return {
        list(): Candidate[] {
            return [...table.values()]
        },

        get(name: string): Candidate | null {
            return table.get(name) ?? null
        },

        observe(candidate: Candidate): void {
            table.set(candidate.axis.name, candidate)
        },

        drop(name: string): void {
            table.delete(name)
        },
    }
}

export type CandidatesHandle = ReturnType<typeof Candidates>
