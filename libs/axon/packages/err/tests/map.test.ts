import { errorMap } from "../src/map"
import { describe, it, expect } from "bun:test"

/**
 * The map's contract, enforced.
 *
 * A code is a stable identity a user or a support thread can reference —
 * which only holds if exactly one failure answers to it. Six codes were
 * duplicated across distinct entries before this test existed
 * (AX-PROJECT-004/005/006/009/011/012 each named two unrelated failures), so
 * a reader given "AX-PROJECT-011" could not tell a wrong project kind from a
 * missing tar binary. The map is hand-numbered and 150+ entries long; nothing
 * but this test stops the next collision.
 */
describe("error map", () => {
    it("gives every entry a unique code", () => {
        const seen = new Map<string, string>()
        const collisions: string[] = []

        for (const [name, entry] of Object.entries(errorMap)) {
            const previous = seen.get(entry.code)
            if (previous) collisions.push(`${entry.code}: ${previous} and ${name}`)
            else seen.set(entry.code, name)
        }

        expect(collisions).toEqual([])
    })

    it("gives every entry the AX-<DOMAIN>-<NNN> shape", () => {
        const malformed = Object.entries(errorMap)
            .filter(([, entry]) => !/^AX-[A-Z]+-\d{3}$/.test(entry.code))
            .map(([name, entry]) => `${name}: ${entry.code}`)

        expect(malformed).toEqual([])
    })

    it("gives every entry a title and a description", () => {
        const incomplete = Object.entries(errorMap)
            .filter(([, entry]) => !entry.title?.trim() || !entry.description?.trim())
            .map(([name]) => name)

        expect(incomplete).toEqual([])
    })
})

/**
 * Provider failures are the USER'S, and wear their own namespace.
 *
 * ── Why the split ───────────────────────────────────────────────────────────
 *
 * These two answer different questions and only one of them is the user's. A
 * provider refusing a credential, running out of credit or rate-limiting is
 * COMMON, entirely about the user's own accounts, and fixable by them. A
 * kernel failure is rare and ours to debug.
 *
 * They shared a namespace, so a spent ChatGPT allowance reached the user as an
 * `AX-KERNEL-…` code — which reads as "the runtime broke" for a situation
 * where nothing had. The wording was already right; the label contradicted it.
 */
describe("the provider namespace", () => {
    const providers = Object.entries(errorMap)
        .filter(([, entry]) => entry.code.startsWith("AX-PROVIDER-"))

    it("covers every user-facing provider failure", () => {
        // Named explicitly rather than counted: a new provider failure should
        // have to be added here deliberately, and one that quietly lands in
        // AX-KERNEL is the regression this guards.
        const names = providers.map(([name]) => name).sort()

        expect(names).toEqual([
            "ENGINE_AUTH_FAILED",
            "ENGINE_NOT_CONNECTED",
            "ENGINE_QUOTA_EXHAUSTED",
            "ENGINE_RATE_LIMITED",
            "ENGINE_REQUEST_REJECTED",
            "ENGINE_UNREACHABLE",
        ])
    })

    it("marks them all as the user's to fix", () => {
        // `expected` suppresses OUR stack frames. A user told to top up their
        // credits does not need seven lines of runtime internals to do it, and
        // an unexpected error printing a full report over a one-line
        // instruction is how the actionable half gets lost.
        for (const [name, entry] of providers) {
            expect(`${name}:${entry.expected}`).toBe(`${name}:true`)
        }
    })

    it("sources them to the provider, not the kernel", () => {
        for (const [name, entry] of providers) {
            expect(`${name}:${entry.source}`).toBe(`${name}:provider`)
        }
    })

    it("keeps the engine failure that is OURS in the kernel namespace", () => {
        // What is left after the classified failures above is a model that
        // returned nothing, a driver that broke the wire protocol, or a fault
        // nothing recognised. The user cannot act on any of those, and the
        // full report is what makes it debuggable from a pasted log.
        expect(errorMap.ENGINE_STREAM_FAILED.code).toStartWith("AX-KERNEL-")
        expect(errorMap.ENGINE_STREAM_FAILED.expected).toBeUndefined()
    })

    it("leaves no provider failure wearing a kernel code", () => {
        // The regression in one assertion: a user-fixable provider fault that
        // reads as a runtime bug.
        const misfiled = Object.entries(errorMap)
            .filter(([, entry]) => entry.source === "provider" && !entry.code.startsWith("AX-PROVIDER-"))
            .map(([name]) => name)

        expect(misfiled).toEqual([])
    })
})
