import { isPropagationLag, withPropagationRetry, PROPAGATION_ATTEMPTS, propagationBudgetMs } from "../../../src/build/project/propagation"
import { describe, it, test, expect } from "bun:test"

/**
 * npm propagation lag.
 *
 * A just-published version is briefly invisible from some npm edges. The CLI
 * pins framework versions matching ITSELF, so the first `axon init` after an
 * `axon update` asks for exactly the versions just published — which is how
 * `axon update` succeeded and the next command failed against the same
 * registry, seconds apart.
 *
 * Two implementations existed. The updater retried four times with backoff and
 * worked; the dependency installer retried ONCE, immediately, with
 * `--no-cache` — which bypasses Bun's manifest cache but cannot make an edge
 * serve what it has not received. These pin the shared policy.
 */

const LAG = `error: No version matching "2.0.159" found for specifier "@arcforge/cognet" (but package exists)`

describe("isPropagationLag", () => {
    it("recognises Bun's phrasing", () => {
        expect(isPropagationLag(LAG)).toBe(true)
    })

    /**
     * Deliberately narrow. "(but package exists)" is the whole signal — it
     * says the package resolved and only the version did not, which is what
     * separates lag from a bad pin.
     */
    it("does not match a package that genuinely does not exist", () => {
        expect(isPropagationLag(`error: package "@cody/nope" not found`)).toBe(false)
    })

    it("does not match auth or network failures", () => {
        expect(isPropagationLag("error: 401 Unauthorized")).toBe(false)
        expect(isPropagationLag("error: ConnectionRefused")).toBe(false)
    })
})

describe("withPropagationRetry", () => {
    /** A sleep that records rather than waits, so the ladder is assertable. */
    function recorder() {
        const waits: number[] = []
        return { waits, sleep: async (ms: number) => void waits.push(ms) }
    }

    it("returns immediately on success, with no waiting", async () => {
        const { waits, sleep } = recorder()
        let calls = 0
        const result = await withPropagationRetry(async () => { calls++; return { ok: true } }, { sleep })

        expect(result.ok).toBe(true)
        expect(calls).toBe(1)
        expect(waits).toEqual([])
    })

    it("retries lag with exponential backoff", async () => {
        const { waits, sleep } = recorder()
        let calls = 0
        // Succeeds on the third attempt, as a real propagation race does.
        const result = await withPropagationRetry(
            async () => { calls++; return calls < 3 ? { ok: false, output: LAG } : { ok: true } },
            { sleep },
        )

        expect(result.ok).toBe(true)
        expect(calls).toBe(3)
        expect(waits).toEqual([1_000, 2_000])
    })

    /**
     * The reason classification matters: seven seconds spent re-asking about a
     * package that does not exist is seven seconds to say the same thing.
     */
    it("gives up at once on a failure that is not lag", async () => {
        const { waits, sleep } = recorder()
        let calls = 0
        const result = await withPropagationRetry(
            async () => { calls++; return { ok: false, output: "error: 401 Unauthorized" } },
            { sleep },
        )

        expect(result.ok).toBe(false)
        expect(calls).toBe(1)
        expect(waits).toEqual([])
    })

    /**
     * The updater's case: it runs bun with inherited stderr so the user
     * watches directly, which means it never sees the text to classify on.
     */
    it("retries unconditionally when the caller cannot capture output", async () => {
        const { sleep } = recorder()
        let calls = 0
        await withPropagationRetry(async () => { calls++; return { ok: false } }, { sleep })

        expect(calls).toBe(PROPAGATION_ATTEMPTS)
    })

    it("reports each wait, so a multi-second pause is not a silent hang", async () => {
        const { sleep, waits } = recorder()
        const reported: number[] = []
        await withPropagationRetry(
            async () => ({ ok: false, output: LAG }),
            { sleep, onRetry: delay => reported.push(delay) },
        )

        // Every wait is ANNOUNCED — that is the property, and it is what the
        // budget increase depends on: a minute of silent backoff is
        // indistinguishable from a hang, which is how it was first reported.
        // Compared against the sleeps actually taken rather than pinned to
        // literals, so retuning the policy cannot leave a pause unreported.
        expect(reported).toEqual(waits)
        expect(reported.length).toBe(PROPAGATION_ATTEMPTS - 1)
        // And the delays themselves still back off rather than busy-looping.
        expect(reported).toEqual([...reported].sort((a, b) => a - b))
        expect(reported[0]).toBe(1_000)
    })
})

describe("the retry budget", () => {
    /**
     * The budget is the whole fix, so it is pinned rather than left to drift.
     *
     * It was four attempts across ~7s, chosen against an assumption that npm
     * propagation is near-instant. It is not: a release observed during this
     * work was still 404ing well past seven seconds and resolved inside a
     * minute, so the retry ran, exhausted, and handed the user a raw registry
     * error for a condition that fixes itself. Anything under ~60s reopens
     * that hole.
     */
    test("covers at least a minute of propagation", () => {
        expect(propagationBudgetMs()).toBeGreaterThanOrEqual(60_000)
    })

    test("is bounded — a real miss must not hang the caller", () => {
        expect(propagationBudgetMs()).toBeLessThanOrEqual(120_000)
        expect(PROPAGATION_ATTEMPTS).toBeLessThanOrEqual(8)
    })

    /**
     * The budget must be what the loop actually spends, not a number beside
     * it — the two drifting apart is how a "60s" budget silently becomes 7s.
     */
    test("matches what the retry loop actually waits", async () => {
        let waited = 0
        await withPropagationRetry(
            async () => ({ ok: false, output: LAG }),
            { sleep: async (ms: number) => { waited += ms } },
        )
        expect(waited).toBe(propagationBudgetMs())
    })
})
