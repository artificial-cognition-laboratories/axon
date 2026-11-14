/**
 * Seeded PRNG. A bench number you cannot reproduce is not a result, and
 * `Math.random()` cannot be seeded — so every stochastic choice in the lab comes
 * through here.
 *
 * mulberry32: small, fast, good enough for generating test corpora. Not for
 * anything cryptographic.
 */
export function Rng(seed: number) {
    let state = seed >>> 0

    const handle = {
        /** Uniform [0, 1). */
        next(): number {
            state = (state + 0x6d2b79f5) >>> 0
            let t = state
            t = Math.imul(t ^ (t >>> 15), t | 1)
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        },

        /** Uniform [min, max). */
        between(min: number, max: number): number {
            return min + handle.next() * (max - min)
        },

        /** Standard normal, via Box-Muller. */
        normal(): number {
            const u = Math.max(handle.next(), Number.EPSILON)
            const v = handle.next()
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
        },

        /** An index into `weights`, chosen proportionally. */
        weighted(weights: readonly number[]): number {
            const total = weights.reduce((sum, w) => sum + w, 0)
            let roll = handle.next() * total
            for (let i = 0; i < weights.length; i++) {
                roll -= weights[i]!
                if (roll <= 0) return i
            }
            return weights.length - 1
        },

        int(max: number): number {
            return Math.floor(handle.next() * max)
        },

        /** Fisher-Yates, in place. */
        shuffle<T>(items: T[]): T[] {
            for (let i = items.length - 1; i > 0; i--) {
                const j = handle.int(i + 1)
                const a = items[i]!
                items[i] = items[j]!
                items[j] = a
            }
            return items
        },
    }

    return handle
}

export type RngHandle = ReturnType<typeof Rng>
