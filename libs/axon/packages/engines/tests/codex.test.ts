import { afterEach, describe, expect, it, test } from "bun:test"
import { HttpError } from "@arcforge/types"
import type { AxonEngineRequest, EngineCloud } from "@arcforge/types"
import { EngineFailure } from "../src"
import { CodexDriver as Codex } from "../src/drivers"

const request: AxonEngineRequest = { messages: [{ role: "user", content: "hello" }] }
const originalFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = originalFetch
})

function cloudWithTokenFailure(error: Error): EngineCloud {
    return {
        user: { vault: { connections: {
            openai: { token: () => Promise.reject(error) },
            openrouter: { token: () => Promise.reject(new Error("unused")) },
        } } },
        cloud: { engine: {
            // eslint-disable-next-line require-yield
            async *stream(): AsyncGenerator<never> { throw new Error("unused") },
            request: () => Promise.reject(new Error("unused")),
        } },
    }
}

function cloudWithToken(): EngineCloud {
    return {
        user: { vault: { connections: {
            openai: { token: async () => ({ accessToken: "test", accountId: "account" }) },
            openrouter: { token: () => Promise.reject(new Error("unused")) },
        } } },
        cloud: { engine: {
            // eslint-disable-next-line require-yield
            async *stream(): AsyncGenerator<never> { throw new Error("unused") },
            request: () => Promise.reject(new Error("unused")),
        } },
    }
}

describe("Codex engine authentication", () => {
    it("classifies a missing OpenAI vault connection as non-retryable", async () => {
        const missing = new HttpError(404, "/api/user/vault/connections/openai/token", "not connected", {
            code: "VAULT_CONNECTION_NOT_FOUND",
            provider: "openai",
        })
        const driver = Codex({ model: "gpt-test" }).create({ env: {}, cloud: cloudWithTokenFailure(missing) })

        try {
            await Array.fromAsync(driver.stream(request))
            throw new Error("expected Codex stream to fail")
        } catch (error) {
            expect(error).toBeInstanceOf(EngineFailure)
            expect((error as EngineFailure).fault).toMatchObject({
                code: "AUTH_NOT_CONNECTED",
                provider: "codex",
                model: "gpt-test",
                retryable: false,
                status: 404,
            })
            expect((error as Error).message).toContain(":provider codex connect")
        }
    })

    it("does not relabel unrelated token failures", async () => {
        const original = new HttpError(401, "/api/user/vault/connections/openai/token", "session expired")
        const driver = Codex().create({ env: {}, cloud: cloudWithTokenFailure(original) })

        await expect(Array.fromAsync(driver.stream(request))).rejects.toBe(original)
    })
})

describe("Codex streaming terminal snapshots", () => {
    it("uses a completed response snapshot when output_text.done is absent", async () => {
        globalThis.fetch = (async () => new Response([
            "data: " + JSON.stringify({
                type: "response.completed",
                response: {
                    status: "completed",
                    output: [{ type: "message", content: [{ type: "output_text", text: "<text>hello</text>" }] }],
                },
            }),
            "",
        ].join("\n"))) as typeof fetch

        const driver = Codex({ model: "gpt-test" }).create({ env: {}, cloud: cloudWithToken() })
        const events = await Array.fromAsync(driver.stream(request))

        expect(events).toEqual([{
            type: "done",
            response: expect.objectContaining({ text: "<text>hello</text>" }),
        }])
    })

    it("uses an output-item snapshot when its text finalizer is absent", async () => {
        globalThis.fetch = (async () => new Response([
            "data: " + JSON.stringify({
                type: "response.output_item.done",
                item: { type: "message", content: [{ type: "output_text", text: "<text>hello</text>" }] },
            }),
            "",
        ].join("\n"))) as typeof fetch

        const driver = Codex({ model: "gpt-test" }).create({ env: {}, cloud: cloudWithToken() })
        const events = await Array.fromAsync(driver.stream(request))

        expect(events).toEqual([{
            type: "done",
            response: expect.objectContaining({ text: "<text>hello</text>" }),
        }])
    })
})
