import { AxonCloud } from "../../src"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("registry.models", () => {
    it("axon: serves the billed catalog with user-facing (marked-up) pricing, no auth needed", async () => {
        const cloud = anonymousCloud()

        const models = await cloud.registry.models.axon()

        expect(models.length).toBeGreaterThan(100)
        const model = models[0]!
        expect(model.id).toContain("/") // canonical vendor/slug ids
        expect(model.pricing.inPerMTok).toBeGreaterThanOrEqual(0)
        expect(model.pricing.outPerMTok).toBeGreaterThanOrEqual(0)
        // raw upstream numbers and margin must not leak
        expect("markup" in model).toBe(false)
        expect("upstream" in model).toBe(false)
    })

    it("all: merges one entry per canonical model with routes; anonymous callers get no codex routes", async () => {
        const cloud = anonymousCloud()

        const catalog = await cloud.registry.models.all()

        expect(catalog.models.length).toBeGreaterThan(100)
        expect(catalog.failures).toEqual([])

        const ids = catalog.models.map(m => m.id)
        expect(new Set(ids).size).toBe(ids.length) // canonical — no duplicates

        for (const model of catalog.models) {
            expect(model.routes.length).toBeGreaterThan(0)
            // codex entitlement is per-user — an anonymous catalog must never carry it
            expect(model.routes.some(r => r.via === "codex")).toBe(false)
        }

        const priced = catalog.models.find(m => m.routes.some(r => r.via === "axon"))
        expect(priced).toBeDefined()
    })

    it("openrouter: lists the live public catalog, chat-capable only, priced per 1M", async () => {
        const cloud = anonymousCloud()

        const models = await cloud.registry.models.openrouter()

        expect(models.length).toBeGreaterThan(100)
        const priced = models.find(m => m.pricing && m.pricing.prompt > 0 && m.pricing.completion > 0)
        expect(priced).toBeDefined()
        expect(priced!.pricing!.prompt).toBeGreaterThan(0)
    })
})
