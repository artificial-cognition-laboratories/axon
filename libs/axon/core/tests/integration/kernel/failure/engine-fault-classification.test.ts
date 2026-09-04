import { Axon, driver } from "../../../setup/axon"
import { EngineFailure } from "@arcforge/engines"
import type { AxonEngineDef, AxonEngineFault, AxonEngineRawEvent } from "@arcforge/types"

/**
 * Which error a provider fault becomes, and how much of our machinery the user
 * has to look at.
 *
 * ── What this defends ───────────────────────────────────────────────────────
 *
 * Drivers classify failures precisely and write a provider-specific sentence
 * for each — "Codex: usage limit reached. Check your ChatGPT subscription.",
 * "OpenRouter: insufficient credits — top up at openrouter.ai". All of it was
 * collapsed into one internal `ENGINE_STREAM_FAILED`, so a spent subscription
 * reached the user as a bare `AX-KERNEL-008` and a stack trace through code
 * they did not write.
 *
 * The rule these tests hold: if the USER can fix it, the error is `expected` —
 * headline plus the driver's own sentence, no frames. If the MODEL or the
 * DRIVER misbehaved, it stays `ENGINE_STREAM_FAILED` and keeps the full report,
 * because that one is ours to debug.
 *
 * The `expected` assertions are the load-bearing half. A code could be mapped
 * correctly and still render eighty lines of our internals at someone whose
 * real problem is an expired API key.
 */

/** A driver that fails with one specific, fully-formed provider fault. */
function faultingEngine(fault: AxonEngineFault): AxonEngineDef {
    return {
        name: "faulting",
        // eslint-disable-next-line require-yield
        create: () => ({
            async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                throw new EngineFailure(fault)
            },
        }),
    }
}

function fault(code: AxonEngineFault["code"], message: string): AxonEngineFault {
    // retryable: false throughout — these tests are about how a SETTLED failure
    // is presented, not about the retry ladder (engine-retry.test.ts owns that).
    return { code, message, retryable: false, provider: "codex", model: "gpt-5.6-luna" }
}

async function failWith(input: AxonEngineFault): Promise<{ code: string; expected: boolean; message: string; context: Record<string, unknown> }> {
    const runtime = await Axon({ blueprint: { config: { providers: [driver(faultingEngine(input))] } } })
    try {
        await runtime.kernel.request({ content: "hello" })
        throw new Error("expected the request to reject")
    } catch (error) {
        const axon = error as { code: string; expected?: boolean; message: string; context?: Record<string, unknown> }
        return {
            code: axon.code,
            expected: axon.expected === true,
            message: axon.message,
            context: axon.context ?? {},
        }
    } finally {
        await runtime.shutdown()
    }
}

describe("kernel failure: provider faults become errors the user can act on", () => {
    it("a spent subscription reads as a rate limit, not an internal error", async () => {
        // The observed case: `AX-KERNEL-008` on screen for a ChatGPT plan that
        // had run out, with our stack underneath it.
        const result = await failWith(fault("RATE_LIMIT", "Codex: usage limit reached. Check your ChatGPT subscription."))

        expect(result.code).toBe("AX-PROVIDER-003")
        expect(result.expected).toBe(true)
        // The driver's sentence survives — it is the most specific thing on
        // screen and the only part naming the actual fix.
        expect(result.message).toContain("ChatGPT subscription")
    })

    it("exhausted credits read as credits, not as a rate limit", async () => {
        // QUOTA and RATE_LIMIT both mean "the provider said no" but need
        // different actions: one is waiting, the other is paying.
        const result = await failWith(fault("QUOTA", "OpenRouter: insufficient credits — top up at openrouter.ai"))

        expect(result.code).toBe("AX-PROVIDER-004")
        expect(result.expected).toBe(true)
    })

    it("a rejected credential reads as an auth problem", async () => {
        const result = await failWith(fault("AUTH", "Codex: authentication failed — reconnect via `:provider openai connect`."))

        expect(result.code).toBe("AX-PROVIDER-002")
        expect(result.expected).toBe(true)
    })

    it("an unconnected provider reads as unconnected", async () => {
        const result = await failWith(fault("AUTH_NOT_CONNECTED", "Codex: not connected"))

        expect(result.code).toBe("AX-PROVIDER-001")
        expect(result.expected).toBe(true)
    })

    it("a request the provider refused names that, not a generic failure", async () => {
        const result = await failWith(fault("INVALID_REQUEST", "codex: unknown model"))

        expect(result.code).toBe("AX-PROVIDER-005")
        expect(result.expected).toBe(true)
    })

    it("an unreachable provider reads as a network problem, not an agent problem", async () => {
        const result = await failWith(fault("TRANSPORT", "codex: connection reset"))

        expect(result.code).toBe("AX-PROVIDER-006")
        expect(result.expected).toBe(true)
    })

    it("carries the full fault into context whichever error was chosen", async () => {
        // The classified error is for the user; the session log still needs
        // everything, or a support conversation has less to go on than before.
        const result = await failWith(fault("RATE_LIMIT", "Codex: usage limit reached."))

        expect(result.context.code).toBe("RATE_LIMIT")
        expect(result.context.provider).toBe("codex")
        expect(result.context.model).toBe("gpt-5.6-luna")
        expect(result.context.attempts).toBe(1)
    })

    describe("failures that are OURS keep the full report", () => {
        it("an empty response stays an internal error", async () => {
            // The model returned nothing. No user action exists, and the
            // frames are what make it debuggable from a pasted log.
            const result = await failWith(fault("EMPTY_RESPONSE", "codex: empty response from model"))

            expect(result.code).toBe("AX-KERNEL-008")
            expect(result.expected).toBe(false)
        })

        it("a protocol violation stays an internal error", async () => {
            const result = await failWith(fault("PROTOCOL", "codex: malformed data frame"))

            expect(result.code).toBe("AX-KERNEL-008")
            expect(result.expected).toBe(false)
        })

        it("an unrecognised fault stays an internal error", async () => {
            // The safe default: a fault code nobody mapped must fall through to
            // the honest generic error rather than be miscategorised as
            // something the user can fix.
            const result = await failWith(fault("UNKNOWN", "codex: something went wrong"))

            expect(result.code).toBe("AX-KERNEL-008")
            expect(result.expected).toBe(false)
        })
    })
})
