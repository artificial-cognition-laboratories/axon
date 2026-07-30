/**
 * Roll a single die with the given number of sides.
 * The core of every check — `roll(20)` is the d20 the whole game turns on.
 *
 * @param sides number of faces (20 for a d20, 6 for a d6, etc.)
 * @returns an integer from 1 to `sides`
 */
export function roll(sides: number = 20): number {
    return 1 + Math.floor(Math.random() * sides)
}

/**
 * Roll a d20 check and get back everything needed to narrate the result:
 * the raw die, whether it was a natural 1 or natural 20, and the total after
 * an optional modifier. Use this for any action where the outcome is uncertain
 * and the stakes are real.
 *
 * ```ts
 * const c = check()          // straight d20
 * const c = check(3)         // d20 + 3 (a character who's good at this)
 * // c => { die: 14, total: 17, nat20: false, nat1: false }
 * ```
 *
 * @param modifier added to the die for the final total (default 0)
 */
export function check(modifier: number = 0): {
    die: number
    total: number
    nat20: boolean
    nat1: boolean
} {
    const die = roll(20)
    return {
        die,
        total: die + modifier,
        nat20: die === 20,
        nat1: die === 1,
    }
}

/**
 * Roll a d20 with advantage (roll twice, keep the higher) or disadvantage
 * (keep the lower) — the classic way to reflect favorable or unfavorable
 * circumstances without fiddly modifiers. Returns both dice so you can see
 * what happened, plus the kept die and nat 1/20 flags on the kept result.
 *
 * ```ts
 * const r = withEdge("advantage")     // circumstances favor the player
 * const r = withEdge("disadvantage")  // the deck is stacked against them
 * // r => { dice: [8, 17], kept: 17, nat20: false, nat1: false }
 * ```
 */
export function withEdge(kind: "advantage" | "disadvantage"): {
    dice: [number, number]
    kept: number
    nat20: boolean
    nat1: boolean
} {
    const a = roll(20)
    const b = roll(20)
    const kept = kind === "advantage" ? Math.max(a, b) : Math.min(a, b)
    return {
        dice: [a, b],
        kept,
        nat20: kept === 20,
        nat1: kept === 1,
    }
}

/**
 * Roll several dice of the same kind and sum them — for variety and flavor
 * (how much something hurts, how much loot spills out, a big dramatic swing).
 * Returns the individual dice and their total.
 *
 * ```ts
 * const r = rollMany(3, 6)   // 3d6
 * // r => { rolls: [4, 2, 6], total: 12 }
 * ```
 *
 * @param count how many dice to roll
 * @param sides faces per die
 */
export function rollMany(count: number, sides: number): { rolls: number[]; total: number } {
    const rolls = Array.from({ length: count }, () => roll(sides))
    return { rolls, total: rolls.reduce((sum, n) => sum + n, 0) }
}
