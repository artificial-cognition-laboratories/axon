/**
 * npm propagation lag — the one policy, shared by everything that installs.
 *
 * A just-published version is not visible from every npm edge immediately. For
 * a few seconds, a machine can ask for a version that genuinely exists and be
 * told it does not, phrased by Bun as:
 *
 *     No version matching "2.0.159" found for specifier "@arcforge/cognet"
 *     (but package exists)
 *
 * That parenthetical is the tell: the package resolved, the version did not, so
 * this is lag rather than a bad pin.
 *
 * ── Why it lives here rather than in each caller ───────────────────────────
 *
 * There were two implementations. `services/update/installer.ts` retried FOUR
 * times with exponential backoff, and worked. `project/tree.ts` retried ONCE,
 * immediately, with `--no-cache` — which bypasses Bun's manifest cache but
 * cannot make an edge serve a version it has not received yet, so the retry
 * consumed the race rather than waiting it out.
 *
 * The consequence was that `axon update` succeeded and the very next
 * `axon init` failed, against the same registry, seconds apart: the CLI pins
 * framework versions matching itself, so a fresh agent asks for exactly the
 * versions that were just published.
 *
 * One policy, one place.
 */

/**
 * How many times to ask, and for how long in total.
 *
 * Seven attempts spans ~63s of backoff (1+2+4+8+16+32). The previous budget was
 * four attempts across ~7s, chosen against an assumption that propagation is
 * near-instant — measured against npm it is not. A publish observed during this
 * work was still invisible to the edge well past the seven-second mark and
 * landed comfortably inside a minute, which is the shape npm's own guidance
 * describes.
 *
 * The cost of overshooting is a slow first run after a release; the cost of
 * undershooting is a hard failure on a condition that resolves itself, which is
 * strictly worse. It is also bounded: only a genuine lag signature retries at
 * all (see `isPropagationLag`), so a real miss still fails immediately.
 */
export const PROPAGATION_ATTEMPTS = 7

/**
 * True when a `bun install` failure is propagation lag rather than a real miss.
 *
 * Matched on Bun's exact phrasing, and deliberately narrow: any other failure
 * (a package that does not exist, auth, network) is real and must surface
 * rather than being retried into a timeout.
 */
export function isPropagationLag(output: string): boolean {
    return /No version matching .* found for specifier .*\(but package exists\)/.test(output)
}

/** Backoff before attempt N (1-indexed): 1s, 2s, 4s, 8s, 16s, 32s. */
export function propagationDelay(attempt: number): number {
    return 1_000 * 2 ** (attempt - 1)
}

/** Worst-case total wait, for callers that want to say how long this may take. */
export function propagationBudgetMs(): number {
    let total = 0
    for (let n = 1; n < PROPAGATION_ATTEMPTS; n++) total += propagationDelay(n)
    return total
}

export type PropagationAttempt = {
    /** Did it succeed? */
    ok: boolean
    /**
     * Combined output, for classifying the failure — omit when the caller
     * cannot capture it.
     *
     * The updater is exactly that case: it runs bun with `stderr: "inherit"`
     * so the user watches the install progress directly, which means the text
     * this classifies on never comes back to it. Absent output retries
     * unconditionally, which is what that path already did and is correct for
     * it — a failed global install is worth a few seconds either way.
     */
    output?: string
}

/**
 * Run `attempt` until it succeeds or stops looking like propagation lag.
 *
 * `onRetry` reports the wait so a multi-second pause is legible rather than
 * looking like a hang — a caller with no surface can pass nothing.
 */
export async function withPropagationRetry(
    attempt: (n: number) => Promise<PropagationAttempt>,
    opts: {
        sleep?: (ms: number) => Promise<void>
        onRetry?: (delayMs: number, attempt: number) => void
    } = {},
): Promise<PropagationAttempt> {
    const sleep = opts.sleep ?? Bun.sleep
    let last: PropagationAttempt = { ok: false, output: "" }

    for (let n = 1; n <= PROPAGATION_ATTEMPTS; n++) {
        last = await attempt(n)
        if (last.ok) return last

        // Only lag is worth waiting on when we can tell. A genuine failure
        // surfaces at once rather than costing seven seconds to say the same
        // thing — but a caller that cannot read the output cannot make that
        // distinction, and retrying is the safer default there.
        if (last.output !== undefined && !isPropagationLag(last.output)) return last

        if (n < PROPAGATION_ATTEMPTS) {
            const delay = propagationDelay(n)
            opts.onRetry?.(delay, n)
            await sleep(delay)
        }
    }

    return last
}
