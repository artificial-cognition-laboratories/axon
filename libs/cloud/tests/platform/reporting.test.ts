import { describe, expect, test } from "bun:test"
import { HttpError } from "@arcforge/types"
import { Reporting, scrubContext, toReportFrames } from "../../src/platform/reporting"
import { isReportable } from "../../src/platform/runtime-reporting"

/**
 * The crash-report channel, tested at its two decision points: what is worth
 * reporting, and what is safe to send.
 *
 * Both have already failed silently once during development, in the exact way
 * that makes them dangerous — a scrubber whose regex missed uppercase, and a
 * classifier that used `instanceof` across a package boundary where the class
 * identity differs. Neither threw; both just quietly did the opposite of what
 * they promised. These tests exist so the next such regression is loud.
 */

describe("what gets reported", () => {
    /**
     * Asserted through a captured fetch rather than by reading internals: the
     * observable behaviour is "a request was made, carrying this body".
     */
    function collect() {
        const sent: Array<Record<string, unknown>> = []
        const original = globalThis.fetch
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
            return new Response("{}", { status: 200 })
        }) as typeof fetch
        return {
            sent,
            restore: () => {
                globalThis.fetch = original
            },
        }
    }

    test("a 5xx is reported, and carries its status", async () => {
        const { sent, restore } = collect()
        try {
            const reporting = Reporting({ baseUrl: "http://x" })
            reporting.httpFailure(new HttpError(500, "/api/boom", "exploded"), "/api/boom", "GET")
            await Promise.resolve()

            expect(sent).toHaveLength(1)
            expect(sent[0]?.source).toBe("cloud")
            expect((sent[0]?.context as Record<string, unknown>).status).toBe(500)
        } finally {
            restore()
        }
    })

    /**
     * The filter that keeps this channel readable. A 404 on a name lookup is
     * the system working; reporting it buries real breakage under thousands of
     * expected outcomes, which is how the previous telemetry effort died.
     */
    test("a 4xx is never reported", async () => {
        const { sent, restore } = collect()
        try {
            const reporting = Reporting({ baseUrl: "http://x" })
            reporting.httpFailure(new HttpError(404, "/api/missing", "not found"), "/api/missing", "GET")
            reporting.httpFailure(new HttpError(403, "/api/private", "forbidden"), "/api/private", "GET")
            reporting.httpFailure(new HttpError(400, "/api/bad", "bad input"), "/api/bad", "POST")
            await Promise.resolve()

            expect(sent).toHaveLength(0)
        } finally {
            restore()
        }
    })

    /**
     * Regression: `error instanceof HttpError` returned false because
     * @arcforge/types resolves to more than one module instance across
     * package boundaries. Every 404 fell through to the transport branch and
     * was reported as breakage — the precise inverse of the intended filter.
     *
     * Asserted on a plain object carrying `status` so it cannot pass by class
     * identity: this is what duck-typing has to survive.
     */
    test("classification reads status structurally, not by class identity", async () => {
        const { sent, restore } = collect()
        try {
            const reporting = Reporting({ baseUrl: "http://x" })
            reporting.httpFailure({ status: 404, message: "not found" }, "/api/missing", "GET")
            expect(sent).toHaveLength(0)

            reporting.httpFailure({ status: 503, message: "unavailable" }, "/api/down", "GET")
            await Promise.resolve()
            expect(sent).toHaveLength(1)
        } finally {
            restore()
        }
    })

    test("a transport failure is reported and marked as one", async () => {
        const { sent, restore } = collect()
        try {
            const reporting = Reporting({ baseUrl: "http://x" })
            reporting.httpFailure(new Error("ECONNREFUSED"), "/api/user", "GET")
            await Promise.resolve()

            expect(sent).toHaveLength(1)
            expect((sent[0]?.context as Record<string, unknown>).transport).toBe(true)
        } finally {
            restore()
        }
    })

    /** A crash loop must not become a request storm. */
    test("the same failure is sent once per process", async () => {
        const { sent, restore } = collect()
        try {
            const reporting = Reporting({ baseUrl: "http://x" })
            for (let i = 0; i < 50; i++) {
                reporting.httpFailure(new HttpError(500, "/api/boom", "exploded"), "/api/boom", "GET")
            }
            await Promise.resolve()

            expect(sent).toHaveLength(1)
        } finally {
            restore()
        }
    })

    test("disabling reporting sends nothing at all", async () => {
        const { sent, restore } = collect()
        try {
            const reporting = Reporting({ baseUrl: "http://x", enabled: false })
            reporting.httpFailure(new HttpError(500, "/api/boom", "exploded"), "/api/boom", "GET")
            await Promise.resolve()

            expect(sent).toHaveLength(0)
        } finally {
            restore()
        }
    })
})

describe("what is safe to send", () => {
    test("unknown keys are dropped — allowlist, not denylist", () => {
        const out = scrubContext({ path: "/api/x", promptText: "the user's private prompt", secret: "hunter2" })

        expect(out).toEqual({ path: "/api/x" })
    })

    /**
     * Regression: the first version used `[a-z0-9_]`, so `axon_live_ABC`
     * passed through untouched. A scrubber that misses the obvious case is
     * worse than none, because it is trusted.
     */
    test("credential-shaped values are redacted even under an allowed key", () => {
        expect(scrubContext({ name: "axon_live_ALLCAPSSECRET" }).name).toBe("[redacted]")
        expect(scrubContext({ name: "axon_test_key_0011223344" }).name).toBe("[redacted]")
        // Assembled rather than written whole: a key-shaped literal here trips
        // the public mirror's credential scan, which cannot tell a fixture
        // from the real thing and is right not to try.
        expect(scrubContext({ name: "sk-" + "ABCDEFGHIJKLMNOPQRSTUV" }).name).toBe("[redacted]")
    })

    test("a home directory is reduced to its basename", () => {
        expect(scrubContext({ name: "/home/cody/git/arclabs/agent.ts" }).name).toBe("agent.ts")
        expect(scrubContext({ name: "/Users/someone/project/x.ts" }).name).toBe("x.ts")
    })

    /**
     * Regression: stripping anything containing a slash turned the URL path
     * `/api/agents/x` into `x`, destroying the single most useful field on an
     * HTTP failure report. A URL path carries no identity and must survive.
     */
    test("a URL path is left intact", () => {
        expect(scrubContext({ path: "/api/agents/abc123" }).path).toBe("/api/agents/abc123")
    })

    test("numbers and booleans pass through unchanged", () => {
        expect(scrubContext({ status: 500, transport: true })).toEqual({ status: 500, transport: true })
    })

    test("stack frames keep the failure site and lose the machine", () => {
        const frames = toReportFrames([
            { functionName: "boot", fileName: "/home/cody/git/arclabs/libs/agent.ts", lineNumber: 42 },
        ])

        expect(frames[0]).toEqual({ functionName: "boot", fileName: "agent.ts", lineNumber: 42 })
    })
})

describe("which runtime errors are worth reporting", () => {
    const base = { code: "AX-X-001", title: "T", message: "m", source: "runtime" }

    /**
     * `expected` marks failures the USER caused and can fix — running a
     * command in the wrong directory, naming a prompt that does not exist.
     * There are hundreds of these per real bug, and including them is exactly
     * how a crash dashboard becomes something nobody opens.
     */
    test("an expected failure is never reported, even when fatal", () => {
        expect(isReportable({ ...base, severity: "fatal", expected: true })).toBe(false)
    })

    test("only fatal failures are reported", () => {
        expect(isReportable({ ...base, severity: "fatal" })).toBe(true)
        expect(isReportable({ ...base, severity: "recovered" })).toBe(false)
        expect(isReportable({ ...base, severity: "degraded" })).toBe(false)
    })
})
