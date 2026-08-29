import { Ollama } from "@arcforge/platform/services/ollama"

/**
 * The programmatic Ollama interface, against the real daemon.
 *
 * No mocks: a stubbed Ollama proves only that our own fixtures round-trip. The
 * things worth catching here — a field Ollama renamed, an NDJSON line split
 * across chunks, an in-band error on a 200 stream — only appear against the
 * real thing.
 *
 * Every case tolerates the daemon being absent, because it is optional
 * infrastructure: a machine without Ollama is an ordinary machine, and the
 * suite must stay green on one. `status()` is the gate.
 */

const ollama = Ollama()
const available = await ollama.status()

/** Skip a case that genuinely needs the daemon, rather than failing a clean machine. */
function whenRunning(name: string, run: () => Promise<void>, timeout?: number): void {
    if (available.running) it(name, run, timeout)
    else it.skip(name, run)
}

describe("ollama.status", () => {
    it("answers rather than throwing — 'is Ollama here' is a question, not a fault", async () => {
        const status = await ollama.status()

        expect(typeof status.running).toBe("boolean")
        if (status.running) expect(status.version).toMatch(/^\d+\.\d+/)
        else expect(status.reason.length).toBeGreaterThan(0)
    })

    it("reports not-running for a host with nothing on it, and names the fix", async () => {
        // Port 1 is reserved and never serves — a deterministic absent daemon.
        const status = await Ollama({ host: "http://localhost:1" }).status()

        expect(status.running).toBe(false)
        if (!status.running) expect(status.reason).toMatch(/ollama serve|ollama\.com/)
    })
})

describe("ollama.models — what is on this machine", () => {
    whenRunning("lists local models with real metadata, largest first", async () => {
        const models = await ollama.models.list()

        expect(Array.isArray(models)).toBe(true)
        for (const model of models) {
            expect(model.name).toContain(":")     // always fully qualified
            expect(model.size).toBeGreaterThan(0)
            expect(model.digest.length).toBeGreaterThan(0)
            expect(Number.isNaN(Date.parse(model.modifiedAt))).toBe(false)
        }
        // Descending by size — the order someone reclaiming disk space wants.
        for (let i = 1; i < models.length; i++) {
            expect(models[i - 1]!.size).toBeGreaterThanOrEqual(models[i]!.size)
        }
    }, 30_000)

    whenRunning("has() agrees with list(), and defaults a bare name to :latest", async () => {
        const models = await ollama.models.list()
        if (models.length === 0) return

        const first = models[0]!
        expect(await ollama.models.has(first.name)).toBe(true)
        expect(await ollama.models.has("definitely-not-a-real-model-xyz")).toBe(false)

        // A bare name resolves to its :latest tag — the same defaulting
        // `ollama pull` applies, so a user's mental model matches ours.
        const latest = models.find(model => model.name.endsWith(":latest"))
        if (latest) expect(await ollama.models.has(latest.name.replace(":latest", ""))).toBe(true)
    }, 30_000)

    whenRunning("reports total disk usage consistent with the model list", async () => {
        const [usage, models] = await Promise.all([ollama.models.usage(), ollama.models.list()])

        expect(usage.count).toBe(models.length)
        expect(usage.bytes).toBe(models.reduce((total, model) => total + model.size, 0))
    }, 30_000)

    whenRunning("lists running models as a subset of what is downloaded", async () => {
        const [running, installed] = await Promise.all([ollama.models.running(), ollama.models.list()])
        const names = new Set(installed.map(model => model.name))

        // Nothing can be loaded into memory that is not on disk.
        for (const model of running) expect(names.has(model.name)).toBe(true)
    }, 30_000)

    whenRunning("reports monotonic progress across a real multi-layer download", async () => {
        // A real pull, because this is precisely what a mock cannot prove: a
        // model arrives as SEVERAL layers, each with its own total/completed
        // pair. Reading the newest pair alone sends percent to 1 and back to
        // near-zero once per layer — five times for this model — which reads as
        // a progress bar snapping backwards.
        await ollama.models.remove("tinyllama:latest").catch(() => {})

        const statuses: string[] = []
        let highest = 0
        let sawUnknownPercent = false
        let final: { percent: number | null; total?: number; done: boolean } | null = null

        for await (const progress of ollama.models.pull("tinyllama:latest")) {
            if (!statuses.includes(progress.status)) statuses.push(progress.status)
            if (progress.percent === null) sawUnknownPercent = true
            else {
                expect(progress.percent).toBeGreaterThanOrEqual(highest - 0.0001)
                highest = progress.percent
            }
            if (progress.done) final = progress
        }

        // Null while Ollama resolves the manifest, before any size is known.
        expect(sawUnknownPercent).toBe(true)
        expect(statuses[0]).toBe("pulling manifest")
        expect(final).not.toBeNull()
        expect(final!.percent).toBe(1)
        // The terminal total is the WHOLE download, not the last layer's.
        expect(final!.total).toBeGreaterThan(500_000_000)
        expect(await ollama.models.has("tinyllama:latest")).toBe(true)
    }, 600_000)

    whenRunning("surfaces a pull failure for a model the registry does not have", async () => {
        // Ollama reports this IN-BAND on a 200 stream, not as an HTTP error —
        // the one shape a mocked daemon would almost certainly get wrong.
        const attempt = async () => {
            for await (const _ of ollama.models.pull("axon-nonexistent-model:v0")) { /* drain */ }
        }

        await expect(attempt()).rejects.toMatchObject({ code: "AX-TUI-040" })
    }, 60_000)
})

describe("ollama.registry — what is available", () => {
    it("browses the curated catalog without touching the network", () => {
        const catalog = ollama.registry.browse()

        expect(catalog.length).toBeGreaterThan(0)
        for (const entry of catalog) {
            expect(entry.name).toBe(`${entry.model}:${entry.tag}`)
            expect(entry.description.length).toBeGreaterThan(0)
            expect(entry.capabilities.length).toBeGreaterThan(0)
            // Size is deliberately absent until resolved — a recorded byte
            // count would silently go stale as tags move.
            expect(entry.size).toBeUndefined()
        }
    })

    it("groups the catalog by family and lists a family's variants", () => {
        const families = ollama.registry.families()
        expect(families).toContain("gemma3")
        expect(new Set(families).size).toBe(families.length) // no duplicates

        const variants = ollama.registry.variants("gemma3")
        expect(variants.length).toBeGreaterThan(1)
        for (const variant of variants) expect(variant.model).toBe("gemma3")
    })

    it("resolves a real model's live download size from the upstream registry", async () => {
        const resolved = await ollama.registry.resolve("gemma3:4b")

        expect(resolved).not.toBeNull()
        expect(resolved!.name).toBe("gemma3:4b")
        // A 4B model is gigabytes — a sane floor that still catches a zero or
        // a manifest whose layer sizes were not summed.
        expect(resolved!.size).toBeGreaterThan(1_000_000_000)
    }, 30_000)

    it("returns null for a name the registry does not have — a typo is information, not a fault", async () => {
        expect(await ollama.registry.resolve("axon-nonexistent-model:v0")).toBeNull()
        expect(await ollama.registry.exists("axon-nonexistent-model:v0")).toBe(false)
    }, 30_000)

    it("resolves a model that is NOT in the catalog — the shelf does not fence anyone in", async () => {
        const listed = new Set(ollama.registry.browse().map(entry => entry.name))
        expect(listed.has("tinyllama:latest")).toBe(false)

        // The catalog is what we offer; the registry is what exists.
        expect(await ollama.registry.exists("tinyllama:latest")).toBe(true)
    }, 30_000)

    it("defaults a bare name to its latest tag, as `ollama pull` does", async () => {
        expect(await ollama.registry.exists("tinyllama")).toBe(true)
    }, 30_000)
})

describe("ollama.available — the palette's view", () => {
    whenRunning("marks catalog entries with real sizes and installed state", async () => {
        const [entries, installed] = await Promise.all([ollama.available(), ollama.models.list()])
        const names = new Set(installed.map(model => model.name))

        expect(entries.length).toBe(ollama.registry.browse().length)
        for (const entry of entries) {
            expect(entry.installed).toBe(names.has(entry.name))
            // Every catalog entry is a real published model, so each should
            // have resolved to a size.
            expect(entry.size).toBeGreaterThan(0)
        }
    }, 60_000)
})
