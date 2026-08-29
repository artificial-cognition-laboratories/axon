import { describe, expect, test } from "bun:test"
import { Events } from "@arcforge/platform/test"

/**
 * The authoritative lifecycle stream.
 *
 * Three properties everything downstream depends on, none of which the runner
 * should have to re-establish: events sort deterministically, a case that
 * started and never finished is recoverable, and a subscriber sees the stream
 * as a sequence rather than interleaved.
 */

const RUN = "run-1"

describe("Events — ordering", () => {
    test("stamps a monotonic sequence so events sort identically however they arrived", () => {
        const events = Events({ runId: RUN })

        events.record("test:run:start", { files: ["a.test.ts"] })
        events.record("test:file:start", {}, { file: "a.test.ts" })
        events.record("test:file:complete", { exitCode: 0, durationMs: 1 }, { file: "a.test.ts" })

        const sequence = events.all.map(event => event.time.seq)
        expect(sequence).toEqual([0, 1, 2])
    })

    test("correlates every event to the run", () => {
        const events = Events({ runId: RUN })
        events.record("test:run:start", { files: [] })

        expect(events.all[0]!.context.testRunId).toBe(RUN)
    })

    test("gives every event a distinct id", () => {
        const events = Events({ runId: RUN })
        for (let i = 0; i < 5; i++) events.record("test:file:start", {}, { file: `${i}.test.ts` })

        expect(new Set(events.all.map(event => event.id)).size).toBe(5)
    })
})

describe("Events — liveness", () => {
    test("reports a started case that never reported a terminal result", () => {
        const events = Events({ runId: RUN })
        const context = { file: "a.test.ts", testId: "a::one" }

        events.record("test:case:start", {}, context)

        expect(events.orphaned("a.test.ts")).toHaveLength(1)
        expect(events.orphaned("a.test.ts")[0]!.testId).toBe("a::one")
    })

    test("clears a case once it passes or fails", () => {
        const events = Events({ runId: RUN })
        const passing = { file: "a.test.ts", testId: "a::one" }
        const failing = { file: "a.test.ts", testId: "a::two" }

        events.record("test:case:start", {}, passing)
        events.record("test:case:start", {}, failing)
        events.record("test:case:pass", { durationMs: 1 }, passing)
        events.record("test:case:fail", { durationMs: 1, error: {} as never }, failing)

        expect(events.orphaned("a.test.ts")).toEqual([])
    })

    test("tracks retries of one case independently", () => {
        const events = Events({ runId: RUN })
        const context = { file: "a.test.ts", testId: "a::flaky" }

        events.record("test:case:start", {}, { ...context, attempt: 0 })
        events.record("test:case:fail", { durationMs: 1, error: {} as never }, { ...context, attempt: 0 })
        events.record("test:case:start", {}, { ...context, attempt: 1 })

        // The retry is still owed an answer; the first attempt already gave one.
        expect(events.orphaned("a.test.ts")).toHaveLength(1)
        expect(events.orphaned("a.test.ts")[0]!.attempt).toBe(1)
    })

    test("scopes orphans to one file — a dead child must not indict another file's cases", () => {
        const events = Events({ runId: RUN })

        events.record("test:case:start", {}, { file: "a.test.ts", testId: "a::one" })
        events.record("test:case:start", {}, { file: "b.test.ts", testId: "b::one" })

        expect(events.orphaned("a.test.ts")).toHaveLength(1)
        expect(events.orphaned("b.test.ts")).toHaveLength(1)
    })
})

describe("Events — tally", () => {
    test("counts each terminal state", () => {
        const events = Events({ runId: RUN })
        const at = (testId: string) => ({ file: "a.test.ts", testId })

        events.record("test:case:pass", { durationMs: 1 }, at("one"))
        events.record("test:case:pass", { durationMs: 1 }, at("two"))
        events.record("test:case:fail", { durationMs: 1, error: {} as never }, at("three"))
        events.record("test:case:skip", {}, at("four"))
        events.record("test:case:todo", {}, at("five"))

        expect(events.tally()).toEqual({ passed: 2, failed: 1, skipped: 1, todo: 1 })
    })

    test("reports a file as failed for a hook failure, not only a case failure", () => {
        const events = Events({ runId: RUN })

        events.record("test:hook:fail", { durationMs: 1, error: {} as never }, { file: "a.test.ts" })

        // A beforeAll that throws means the file failed even though no case
        // ever ran — the runner uses this to avoid double-reporting the exit.
        expect(events.failed("a.test.ts")).toBe(true)
        expect(events.failed("b.test.ts")).toBe(false)
    })
})

describe("Events — delivery", () => {
    test("delivers in authoritative order, one at a time", async () => {
        const seen: number[] = []
        const events = Events({
            runId: RUN,
            async onEvent(event) {
                // A slow first subscriber must not let the second overtake it.
                await Bun.sleep(event.time.seq === 0 ? 20 : 0)
                seen.push(event.time.seq)
            },
        })

        events.record("test:run:start", { files: [] })
        events.record("test:file:start", {}, { file: "a.test.ts" })
        events.record("test:file:complete", { exitCode: 0, durationMs: 1 }, { file: "a.test.ts" })
        await events.settle()

        expect(seen).toEqual([0, 1, 2])
    })

    test("records synchronously — a slow subscriber never stalls the run", () => {
        const events = Events({ runId: RUN, onEvent: () => Bun.sleep(50) })

        events.record("test:run:start", { files: [] })

        // Already in the stream, with nothing awaited.
        expect(events.all).toHaveLength(1)
    })

    test("settle() resolves when there is no subscriber", async () => {
        const events = Events({ runId: RUN })
        events.record("test:run:start", { files: [] })

        await expect(events.settle()).resolves.toBeUndefined()
    })
})
