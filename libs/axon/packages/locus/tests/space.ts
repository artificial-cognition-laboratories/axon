import { Space, type Axis } from "../src/pure"

/**
 * One small space, shared by every test that needs a basis.
 *
 * Deliberately tiny and deliberately multi-domain: two domains with different
 * metrics is the minimum that exercises per-domain combination, which is where
 * the distance rules actually live.
 */
export const AXES: Axis[] = [
    { name: "threat", domain: "risk", kind: "score", levels: ["none", "low", "high"], question: "How dangerous is this?" },
    { name: "fragile", domain: "risk", kind: "noul", question: "Does this break easily?" },
    { name: "noisy", domain: "form", kind: "noul", question: "Does this make noise?" },
    { name: "large", domain: "form", kind: "score", levels: ["tiny", "medium", "huge"], question: "How large is this?" },
    { name: "interactive", domain: "use", kind: "noul", question: "Can this be interacted with?" },
]

export function testSpace() {
    return Space({
        axes: AXES,
        domains: {
            risk: { weight: 2 },
            form: { metric: "cosine" },
        },
    })
}

/** The same axis list with one appended — the append-is-free case. */
export function grownSpace() {
    return Space({
        axes: [...AXES, { name: "edible", domain: "use", kind: "noul", question: "Can this be eaten?" }],
    })
}
