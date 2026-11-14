import { describe, expect, it } from "bun:test"
import { Ollama } from "../../src/services/ollama"

describe("Ollama setup health", () => {
    it("reports an absent daemon without hiding a real daemon failure", async () => {
        expect((await Ollama({ host: "http://127.0.0.1:1" }).status()).running).toBe(false)
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "daemon fault" }, { status: 500 }) })
        try {
            await expect(Ollama().at(server.url.toString()).status()).rejects.toMatchObject({ code: "AX-TUI-038" })
        } finally { server.stop(true) }
    })
    it("rejects malformed version data at the health boundary", async () => {
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ unexpected: "value" }) })
        try {
            await expect(Ollama().at(server.url.toString()).status()).rejects.toMatchObject({ code: "AX-TUI-038" })
        } finally { server.stop(true) }
    })
    it("probes the endpoint declared by machine policy", async () => {
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "0.18.0" }) })
        try {
            expect(await Ollama().at(server.url.toString()).status()).toEqual({ running: true, version: "0.18.0" })
        } finally { server.stop(true) }
    })
})
