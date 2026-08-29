import { describe, expect, test } from "bun:test"
import { isFrame, isTestChannel } from "@arcforge/platform/services/test/frames"

/**
 * The IPC boundary.
 *
 * A test child is a subprocess running user code, so everything arriving over
 * its channel is untrusted input. Two separate questions get asked of it:
 *
 *   isTestChannel  is this addressed to us at all? — a domain extension sends
 *                  its own traffic down the same pipe, and that is not a fault
 *   isFrame        is this something we can record? — an unknown type would
 *                  put an event no consumer understands into the stream
 *
 * Conflating them is what makes an extension's perfectly valid message get
 * reported as a protocol fault.
 */

const context = { file: "a.test.ts", testId: "a::one" }

describe("isTestChannel", () => {
    test("accepts anything addressed to the test channel", () => {
        expect(isTestChannel({ channel: "axon:test", frame: {} })).toBe(true)
    })

    test("rejects another channel's traffic — an extension's message is not ours", () => {
        expect(isTestChannel({ channel: "bench:workspace", data: {} })).toBe(false)
    })

    test("rejects values that are not messages at all", () => {
        for (const value of [null, undefined, "a string", 42, []]) {
            expect(isTestChannel(value)).toBe(false)
        }
    })
})

describe("isFrame", () => {
    test("accepts a well-formed frame of a known type", () => {
        expect(isFrame({
            channel: "axon:test",
            frame: { type: "test:case:pass", context, data: { durationMs: 1 } },
        })).toBe(true)
    })

    test("rejects an unknown event type — the allowlist is the contract", () => {
        expect(isFrame({
            channel: "axon:test",
            frame: { type: "test:case:invented", context, data: {} },
        })).toBe(false)
    })

    test("rejects a frame missing its context or data", () => {
        expect(isFrame({ channel: "axon:test", frame: { type: "test:case:pass", data: {} } })).toBe(false)
        expect(isFrame({ channel: "axon:test", frame: { type: "test:case:pass", context } })).toBe(false)
    })

    test("rejects a frame whose type is not a string", () => {
        expect(isFrame({ channel: "axon:test", frame: { type: 7, context, data: {} } })).toBe(false)
    })

    test("rejects a valid-looking frame on the wrong channel", () => {
        expect(isFrame({
            channel: "something:else",
            frame: { type: "test:case:pass", context, data: {} },
        })).toBe(false)
    })

    test("accepts every lifecycle type the child can emit", () => {
        const types = [
            "test:suite:declare", "test:suite:start", "test:suite:complete",
            "test:case:declare", "test:case:start", "test:case:pass", "test:case:fail",
            "test:case:skip", "test:case:todo",
            "test:hook:start", "test:hook:complete", "test:hook:fail",
            "test:console", "test:process:fault",
        ]

        for (const type of types) {
            expect(isFrame({ channel: "axon:test", frame: { type, context, data: {} } })).toBe(true)
        }
    })

    test("rejects run- and file-level types — those are the RUNNER's to emit, never the child's", () => {
        // A child claiming the run started would corrupt the authoritative
        // stream: only the process that owns the run can bracket it.
        for (const type of ["test:run:start", "test:run:complete", "test:file:start", "test:file:complete"]) {
            expect(isFrame({ channel: "axon:test", frame: { type, context, data: {} } })).toBe(false)
        }
    })
})
