import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

// These two tests hit REAL inference, deliberately.
//
// The backend used to swap in a MockUpstream under AXON_STAGING_MODE, and
// these tests asserted its fixtures (the literal string "mock inference",
// exactly 1M in / 1M out tokens). That mock was removed on purpose — see
// platform/engine/engine.ts: "There is no environment flag that silently
// swaps real inference for fake." The sanctioned mock is the user's own
// `providers: [Mock()]` from @arcforge/engines, which is agent-side and never
// reaches this endpoint.
//
// So there is nothing deterministic left to assert about the CONTENT, and
// asserting it was never the point. What this endpoint has to get right is
// the metering: that a stream terminates with an authoritative done, and
// that the cost it reports is exactly what the ledger was debited. Those
// hold whatever the model says, and they are the invariants the reserve /
// capture / release cycle exists to guarantee.
const MODEL = "claude-sonnet-4-6"

// Kept tiny — a real call, so it costs real money on every run.
const request = { messages: [{ role: "user" as const, content: "say hi" }] }

describe("cloud.engine", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()
        await expect(cloud.cloud.engine.request({ model: MODEL, request })).rejects.toThrow()
    })

    it("rejects unknown models loudly", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        await expect(cloud.cloud.engine.request({ model: "not-a-model", request })).rejects.toThrow()
    })

    it("rejects unwired targets (id/url, default model) client-side", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        await expect(cloud.cloud.engine.request({ id: "helios", model: MODEL, request })).rejects.toThrow("not wired yet")
        await expect(cloud.cloud.engine.request({ request })).rejects.toThrow("not wired yet")
    })

    it("streams deltas and terminates with an authoritative done", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const events = []
        for await (const event of cloud.cloud.engine.stream({ model: MODEL, request })) {
            events.push(event)
        }

        const deltas = events.filter(e => e.type === "text:delta")
        expect(deltas.length).toBeGreaterThan(0)

        const last = events.at(-1)!
        expect(last.type).toBe("done")
        if (last.type !== "done") throw new Error("unreachable")

        // The done frame is the authoritative accounting for the call: real
        // text, the model actually routed to, and metering from the provider's
        // own usage numbers rather than anything this test supplies.
        expect(last.response.text.length).toBeGreaterThan(0)
        expect(last.response.meta.provider).toBe("axon")
        expect(last.response.meta.model).toBe("anthropic/claude-sonnet-4.6")

        const tokens = last.response.meta.tokens!
        expect(tokens.in).toBeGreaterThan(0)
        expect(tokens.out).toBeGreaterThan(0)
        expect(tokens.total).toBe(tokens.in + tokens.out)

        expect(last.response.meta.cost?.total).toBeGreaterThan(0)
    }, 30_000)

    // ── resolve ─────────────────────────────────────────────────────────────
    //
    // `Axon({ model: "auto" })` names a POLICY, not a model: the curated table
    // and its scoring live server-side, so a client cannot know what it is on
    // until a call has happened. That left the TUI header showing "auto"
    // indefinitely for anyone who hadn't talked to their agent yet.
    //
    // resolve() answers it up front, running the same scoring `stream` performs
    // as its first step — before billing, before any upstream call. These cover
    // the contract that makes one resolve-per-session sound: it returns a REAL
    // model, it obeys the weights, and it charges nothing.

    it("resolves auto to a real catalog model", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const resolved = await cloud.cloud.engine.resolve({ model: "auto" })

        // The whole point: never the policy string back, always something real.
        expect(resolved.model).not.toBe("auto")
        expect(resolved.model).toContain("/")
        expect(resolved.pricing.inPerMTok).toBeGreaterThan(0)
    })

    it("gives the same answer twice — what makes one resolve per session valid", async () => {
        // The TUI resolves once at boot and shows that for the session. That is
        // only honest if resolution is deterministic for a given selector.
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const first = await cloud.cloud.engine.resolve({ model: "auto" })
        const second = await cloud.cloud.engine.resolve({ model: "auto" })

        expect(second.model).toBe(first.model)
    })

    it("lets optimize weights change the pick", async () => {
        // Weighting is the only reason `auto` is configurable at all — if both
        // extremes resolved the same, optimize would be decorative.
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const cheap = await cloud.cloud.engine.resolve({ model: "auto", optimize: { cost: 1 } })
        const smart = await cloud.cloud.engine.resolve({ model: "auto", optimize: { intelligence: 1 } })

        expect(cheap.model).not.toBe(smart.model)
        expect(smart.pricing.inPerMTok).toBeGreaterThan(cheap.pricing.inPerMTok)
    })

    it("resolves an explicit model, including a legacy alias", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        // "claude-sonnet-4-6" is an old hand-entered id kept resolving so
        // existing configs don't break — it must map to the canonical slug.
        expect((await cloud.cloud.engine.resolve({ model: MODEL })).model).toBe("anthropic/claude-sonnet-4.6")
    })

    it("refuses an unknown model rather than falling back to a default", async () => {
        // A silent fallback here would show the user one model in the header
        // and bill them for another.
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.cloud.engine.resolve({ model: "not-a-model" })).rejects.toThrow()
    })

    it("refuses an auto limit that filters every candidate", async () => {
        // "auto" resolving to nothing is exactly as fatal as a bad explicit id.
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.cloud.engine.resolve({ model: "auto", limit: { cost: 0 } })).rejects.toThrow()
    })

    it("requires auth", async () => {
        await expect(anonymousCloud().cloud.engine.resolve({ model: "auto" })).rejects.toThrow()
    })

    it("charges nothing — it is not a call", async () => {
        // Resolution runs before the funds reserve. If it ever started billing,
        // the header would be charging the user for rendering itself.
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const before = await cloud.user.billing.ledger.list({ limit: 50 })
        await cloud.cloud.engine.resolve({ model: "auto" })
        const after = await cloud.user.billing.ledger.list({ limit: 50 })

        const seen = new Set(before.map(entry => entry.id))
        expect(after.filter(entry => !seen.has(entry.id) && entry.kind === "token_charge")).toHaveLength(0)
    })

    it("debits the ledger by exactly the metered, marked-up cost", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const seen = new Set((await cloud.user.billing.ledger.list({ limit: 50 })).map(e => e.id))
        const response = await cloud.cloud.engine.request({ model: MODEL, request })

        const charged = response.meta.cost?.total
        expect(charged).toBeGreaterThan(0)

        // THE invariant: the done event's cost IS the ledger entry. Whatever the
        // provider metered and however the markup resolved, the number the user
        // was shown and the number they were charged must be the same one — a
        // reserve that captured a different amount than it reported is the bug
        // this test exists to catch.
        //
        // Read against the ledger, not a balance delta. TEST_USER is shared, and
        // its balance also moves for commitment_reservation/commitment_charge as
        // other tests provision deployments — a -4900 commitment landing between
        // two balance reads made this assert 4902 against an expected 2. The
        // ledger entry this request created is specific to it; the account total
        // never was.
        const entries = await cloud.user.billing.ledger.list({ limit: 50 })
        const mine = entries.filter(e => !seen.has(e.id) && e.kind === "token_charge")

        expect(mine).toHaveLength(1)
        expect(Math.abs(mine[0]!.amountMinor)).toBe(charged)
    }, 30_000)
})
