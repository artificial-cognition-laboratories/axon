import { HttpError } from "@arcforge/types"
import type { AxonEngineRequest, EngineCloud } from "@arcforge/types"
import { Codex, EngineFailure } from "../src"

const request: AxonEngineRequest = { messages: [{ role: "user", content: "hello" }] }

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
