import { describe, expect, it } from "bun:test"
import { ask, pending, settled, PROBE_TIMEOUT_MS } from "../../src/machine/ask"

/**
 * Machine probes must not be able to hang their caller.
 *
 * This is a regression test with a real incident behind it, and the incident
 * happened TWICE — which is why the assertions changed shape.
 *
 * First round: every GPU/identity probe used a bare `Bun.spawnSync` with no
 * timeout and `nvidia-smi` hung, taking the process with it. The fix was a 2s
 * bound on the sync spawn, and this file asserted that bound.
 *
 * Second round, 2026-09-08: that was not enough. A `bun test --test-worker
 * --isolate` process was caught alive for 4h57m with `nvidia-smi <defunct>` as
 * its child — the worker spinning on CPU (state R), the child exited and never
 * reaped, the parent never resuming. `spawnSync`'s `timeout` does not bound
 * that. It also poisoned the whole box: load average past 12, and every other
 * suite failing at its exact declared ceiling, which read as unrelated flakes.
 *
 * So the property under test is no longer "the spawn is bounded" but the
 * stronger "nothing is ever spawned synchronously". `ask()` answers from cache
 * and refreshes in the background, which is why these assertions are about
 * RETURNING PROMPTLY rather than about how long a subprocess took.
 *
 * Fixtures are `sleep` and `true`, so this runs identically on a machine with
 * a GPU and one without.
 */
describe("ask — non-blocking external probes", () => {
    it("returns immediately even when the probe will never answer in time", async () => {
        const startedAt = Date.now()
        const probed = ask(["sleep", "30"])
        const elapsed = Date.now() - startedAt

        // The whole point: not 30s, and not the 2s bound either — no wait at all.
        expect(elapsed).toBeLessThan(100)

        /*
         * And it has to be legible to callers as "unknown". Every probe site
         * branches on `exitCode !== 0`, so an unanswered probe must not surface
         * as 0 — that would read as a successful answer with empty output,
         * which is how a hang becomes a wrong metric instead of an absent one.
         */
        expect(probed.exitCode).not.toBe(0)
        expect(pending(probed)).toBe(true)

        await settled()
    })

    it("a caller is never blocked, however many times it asks a hanging probe", () => {
        const startedAt = Date.now()
        for (let i = 0; i < 50; i++) ask(["sleep", "30"])
        // 50 asks against a hung tool still cost nothing. Under the old
        // synchronous bound this was 50 × 2s.
        expect(Date.now() - startedAt).toBeLessThan(PROBE_TIMEOUT_MS)
    })

    it("reports the real answer once the refresh has landed", async () => {
        ask(["true"])
        await settled()
        expect(ask(["true"]).exitCode).toBe(0)
    })

    it("distinguishes 'not answered yet' from 'answered badly'", async () => {
        // Not yet: nothing cached, refresh just started.
        expect(pending(ask(["false"]))).toBe(true)

        await settled()

        // Answered, and the answer is a failure — which is NOT pending. A
        // caller that caches (Hardware latches its reading) depends on this
        // distinction: latching "no GPU" because the first refresh had not
        // landed would be permanently wrong on a machine that has one.
        const answered = ask(["false"])
        expect(pending(answered)).toBe(false)
        expect(answered.exitCode).not.toBe(0)
    })

    it("does not throw when the binary does not exist", async () => {
        // Callers treat absence as "no GPU here" and must never see an
        // exception from asking — a missing vendor tool is the common case.
        expect(() => ask(["definitely-not-a-real-binary-axon-test"])).not.toThrow()
        await settled()
        expect(ask(["definitely-not-a-real-binary-axon-test"]).exitCode).not.toBe(0)
    })
})
