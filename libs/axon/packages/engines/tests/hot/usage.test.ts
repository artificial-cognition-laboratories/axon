import { describe, expect, it } from "bun:test"
import type { AxonEngineDriver, EngineCloud, ProviderUsageRecord } from "@arcforge/types"
import { OpenRouterDriver } from "../../src/drivers"
import { UsageDriver } from "../../src/shared"

function Cloud(record: (input: ProviderUsageRecord) => Promise<void>): EngineCloud {
    return { user: { auth: { token: "identity" }, usage: { record: record }, vault: { connections: {
        openai: { async token() { throw new Error("unused") } }, openrouter: { async token() { throw new Error("unused") } },
    } } }, registry: { models: { async all() { return { models: [], failures: [] } } } },
    cloud: { engine: { async *stream() { throw new Error("unused") }, async request() { throw new Error("unused") } } } }
}
const request = { messages: [] }
function Driver(measured: boolean): AxonEngineDriver {
    return { async *stream() {
        yield { type: "text:delta", content: "answer" }
        yield { type: "done", response: { text: "answer", stopReason: "end", meta: { provider: "openai", model: "actual-model", durationMs: 1,
            ...(measured ? { tokens: { in: 5, out: 3, total: 8 } } : {}) } } }
    } }
}

describe("provider usage metadata", () => {
    it("never releases an account credential to a custom OpenRouter endpoint", async () => {
        let reads = 0
        const cloud = Cloud(async () => {})
        cloud.user.vault.connections.openrouter.token = async () => { reads++; return { accessToken: "private", expiresAt: Date.now() + 1000 } }
        const driver = OpenRouterDriver({ model: "fixture", baseUrl: "https://never-contact.invalid" }).create({ cloud: cloud, env: {} })
        await expect(Array.fromAsync(driver.stream(request))).rejects.toMatchObject({ fault: { code: "INVALID_REQUEST", retryable: false } })
        expect(reads).toBe(0)
    })
    it("allows a token refresh for the same account without misattributing usage", async () => {
        const records: ProviderUsageRecord[] = []
        const auth = { token: "old-token", user: { id: "same-account" } }
        const cloud = Cloud(async input => { records.push(input) })
        cloud.user.auth = auth
        const driver = UsageDriver({ driver: Driver(true), cloud: cloud, provider: "zai", model: "requested", source: "account" })
        const stream = driver.stream(request)
        await stream.next()
        auth.token = "refreshed-token"
        await Array.fromAsync(stream)
        expect(records[0]?.outcome).toBe("completed")
    })
    it("refuses to write a previous account's request to a newly signed-in account", async () => {
        const records: ProviderUsageRecord[] = []
        const auth = { token: "token", user: { id: "first-account" } }
        const cloud = Cloud(async input => { records.push(input) })
        cloud.user.auth = auth
        const driver = UsageDriver({ driver: Driver(true), cloud: cloud, provider: "zai", model: "requested", source: "account" })
        const stream = driver.stream(request)
        await stream.next()
        auth.user.id = "second-account"
        await expect(Array.fromAsync(stream)).rejects.toMatchObject({ fault: { code: "USAGE_REPORT_FAILED", retryable: false } })
        expect(records).toEqual([])
    })
    it("records actual model and reported tokens, without prompts or output", async () => {
        const records: ProviderUsageRecord[] = []
        const cloud = Cloud(async input => { records.push(input) })
        const driver = UsageDriver({ driver: Driver(true), cloud: cloud, provider: "openai-api", model: "requested", source: "account" })
        const events = await Array.fromAsync(driver.stream(request))
        expect(events.at(-1)?.type).toBe("done")
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({ provider: "openai-api", model: "actual-model", source: "account", outcome: "completed", tokens: { in: 5, out: 3 } })
        expect(JSON.stringify(records)).not.toContain("answer")
    })
    it("keeps missing tokens absent and distinguishes machine credentials", async () => {
        const records: ProviderUsageRecord[] = []
        const driver = UsageDriver({ driver: Driver(false), cloud: Cloud(async input => { records.push(input) }), provider: "zai", model: "requested", source: "explicit" })
        await Array.fromAsync(driver.stream(request))
        expect(records[0]?.tokens).toBeUndefined()
        expect(records[0]?.source).toBe("explicit")
    })
    it("records upstream failure and propagates the original error", async () => {
        const records: ProviderUsageRecord[] = []
        const problem = new Error("provider failed")
        const driver = UsageDriver({ driver: { async *stream() { throw problem } }, cloud: Cloud(async input => { records.push(input) }), provider: "zai", model: "requested", source: "account" })
        await expect(Array.fromAsync(driver.stream(request))).rejects.toBe(problem)
        expect(records[0]?.outcome).toBe("failed")
    })
    it("records cancellation when a consumer closes a stream", async () => {
        const records: ProviderUsageRecord[] = []
        const driver = UsageDriver({ driver: Driver(true), cloud: Cloud(async input => { records.push(input) }), provider: "zai", model: "requested", source: "account" })
        const stream = driver.stream(request)
        await stream.next()
        await stream.return(undefined)
        expect(records[0]?.outcome).toBe("cancelled")
    })
    it("does not silently lose a report or allow automatic inference retry", async () => {
        const driver = UsageDriver({ driver: Driver(true), cloud: Cloud(async () => { throw new Error("database unavailable") }), provider: "zai", model: "requested", source: "account" })
        await expect(Array.fromAsync(driver.stream(request))).rejects.toMatchObject({ fault: { code: "USAGE_REPORT_FAILED", retryable: false } })
    })
})
