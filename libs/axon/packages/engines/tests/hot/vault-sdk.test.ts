import { describe, expect, it } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { AxonCloud } from "../../../../../cloud/src"
import { DirectProvider } from "../../src/aisdk"

describe("vault credentials supplied to the AI SDK", () => {
    it("rebinds an existing driver on credential revision changes, using the real SDK transport", async () => {
        let revision = "first"
        const keys: string[] = []
        const client = AxonCloud({ key: "axon_fixture", reporting: false, environmentCredentials: false,
            fetch: Object.assign(async () => Response.json({ accessToken: `${revision}-key`, revision: revision, expiresAt: 0 }), { preconnect: fetch.preconnect }),
        })
        const provider = DirectProvider({ cloud: client, env: {}, definition: {
            name: "groq", env: "GROQ_API_KEY", connection: "groq",
            async load(key) {
                const sdk = createOpenAICompatible({ name: "groq", apiKey: key, baseURL: "https://provider.test/v1",
                    fetch: async (_url, init) => {
                        keys.push(new Headers(init?.headers).get("authorization") ?? "missing")
                        const chunks = [
                            { id: "fixture", model: "fixture", created: 1, choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] },
                            { id: "fixture", model: "fixture", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
                        ]
                        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
                    },
                })
                return model => sdk(model)
            },
        } })
        const driver = provider.create({ id: "fixture", provider: "groq", name: "fixture", type: "generate", in: ["text"], out: ["text"] })
        for (const value of ["first", "second"]) {
            revision = value
            const events = []
            for await (const event of driver.stream({ messages: [{ role: "user", content: "hello" }] })) events.push(event)
            expect(events.at(-1)).toMatchObject({ type: "done", response: { text: "answer" } })
        }
        expect(keys).toEqual(["Bearer first-key", "Bearer second-key"])
    })
    it("does not send an account key to an endpoint override or fall through an empty explicit key", async () => {
        let reads = 0
        const client = AxonCloud({ reporting: false, environmentCredentials: false,
            fetch: Object.assign(async () => { reads++; throw new Error("credential must not be fetched") }, { preconnect: fetch.preconnect }),
        })
        for (const options of [{ url: "https://unexpected.example" }, { key: "" }]) {
            const provider = DirectProvider({ cloud: client, env: {}, ...options, definition: {
                name: "groq", env: "GROQ_API_KEY", connection: "groq",
                async load() { throw new Error("SDK must not be constructed") },
            } })
            const driver = provider.create({ id: "fixture", provider: "groq", name: "fixture", type: "generate", in: ["text"], out: ["text"] })
            await expect(driver.stream({ messages: [] }).next()).rejects.toMatchObject({ fault: expect.objectContaining({ retryable: false }) })
        }
        expect(reads).toBe(0)
    })
})
