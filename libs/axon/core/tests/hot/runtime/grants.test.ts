import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AxonBlueprint, CognetUse, ServiceGrant } from "@arcforge/types"
import type { EnginesT } from "@arcforge/engines/catalogue"
import { Grants } from "../../../src/runtime/grants"
import { engineRoles, granted } from "../../../src/runtime/services"
import { Inject } from "../../../src/platform/inject"

const DEPTH: CognetUse = {
    interface: "depth-relative@1",
    named: "depth-relative@1",
    methods: { describe: { kind: "describe", params: [] }, estimate: { kind: "call", params: ["picture"] } },
}

const FEATURES: CognetUse = {
    interface: "./interfaces/features@1",
    named: "@cody/terry/features@1",
    methods: { describe: { kind: "describe", params: [] }, extract: { kind: "call", params: ["picture", "patch"] } },
}

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-grants-"))
    await mkdir(join(dir, "providers"), { recursive: true })
    // A provider module calls defineProvider at import, as an agent's does.
    Inject().macros()
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

type Written = { name: string; filePath: string; implements: string; engines: Record<string, never> }

/** A provider file, as the scanner would describe it: what it implements is read from the source. */
async function provider(name: string, source: string, engines: Record<string, unknown> = {}): Promise<Written> {
    const filePath = join(dir, "providers", `${name}.provider.ts`)
    await writeFile(filePath, source)
    return { name: `./providers/${name}`, filePath: filePath, implements: source.match(/implements: "([^"]+)"/)![1]!, engines: engines as Record<string, never> }
}

const FEATURES_PROVIDER = `export default defineProvider({
    implements: "@cody/terry/features@1",
    describe: () => ({ patch: 16, gpu: true }),
    async extract(picture, patch) { return { cells: picture.width / patch } },
})
`

function blueprint(uses: Record<string, CognetUse>, services: Record<string, ServiceGrant> | undefined, serviceProviders: Written[]): AxonBlueprint {
    return { cognet: { uses: uses }, config: { ...(services ? { services: services } : {}) }, serviceProviders: serviceProviders } as unknown as AxonBlueprint
}

describe("Grants", () => {
    it("fills a use with the agent's own provider, its arguments positional as the interface writes them", async () => {
        const features = await provider("features", FEATURES_PROVIDER)
        const grants = await Grants({ blueprint: blueprint({ features: FEATURES }, { features: "./providers/features" }, [features]) })
        const granted = grants.granted("features")!
        expect(granted.name).toBe("./providers/features")
        expect(granted.describe()).toEqual({ patch: 16, gpu: true })
        expect(await granted.call("extract", { picture: { width: 64 }, patch: 16 })).toEqual({ cells: 4 })
    })

    it("picks the agent's one provider of an interface under auto", async () => {
        const features = await provider("features", FEATURES_PROVIDER)
        const grants = await Grants({ blueprint: blueprint({ features: FEATURES }, undefined, [features]) })
        expect(grants.granted("features")?.name).toBe("./providers/features")
    })

    it("refuses a provider that implements another interface, or not all of its", async () => {
        const wrong = await provider("wrong", `export default defineProvider({ implements: "depth-relative@1", describe: () => ({}), async estimate() {} })\n`)
        await expect(Grants({ blueprint: blueprint({ features: FEATURES }, { features: "./providers/wrong" }, [wrong]) })).rejects.toThrow(/implements depth-relative@1, but features uses @cody\/terry\/features@1/)
        const partial = await provider("partial", `export default defineProvider({ implements: "@cody/terry/features@1", describe: () => ({}) })\n`)
        await expect(Grants({ blueprint: blueprint({ features: FEATURES }, { features: "./providers/partial" }, [partial]) })).rejects.toThrow(/has no extract/)
    })

    it("leaves an optional use unavailable when nothing fills it, and stops the boot for a required one", async () => {
        const optional = await Grants({ blueprint: blueprint({ depth: { ...DEPTH, optional: true } }, undefined, []) })
        expect(optional.granted("depth")).toBeNull()
        await expect(Grants({ blueprint: blueprint({ depth: DEPTH }, undefined, []) })).rejects.toMatchObject({ code: "AX-SERVICE-001" })
        await expect(Grants({ blueprint: blueprint({ depth: DEPTH }, { depth: "off" }, []) })).rejects.toThrow(/granted off/)
    })

    it("holds a provider to what the use requires of describe()", async () => {
        const features = await provider("features", FEATURES_PROVIDER)
        const use = { ...FEATURES, requires: { patch: { max: 8 } } }
        await expect(Grants({ blueprint: blueprint({ features: use }, undefined, [features]) })).rejects.toThrow(/reports patch 16, which does not meet/)
        const met = await Grants({ blueprint: blueprint({ features: { ...FEATURES, requires: { gpu: true, patch: { min: 8 } } } }, undefined, [features]) })
        expect(met.granted("features")).not.toBeNull()
    })

    it("refuses a call past the grant's limit", async () => {
        const features = await provider("features", FEATURES_PROVIDER)
        const grants = await Grants({ blueprint: blueprint({ features: FEATURES }, { features: { provider: "./providers/features", limit: { calls: 2, per: "minute" } } }, [features]) })
        const granted = grants.granted("features")!
        await granted.call("extract", { picture: { width: 16 }, patch: 16 })
        await granted.call("extract", { picture: { width: 16 }, patch: 16 })
        await expect(granted.call("extract", { picture: { width: 16 }, patch: 16 })).rejects.toMatchObject({ code: "AX-SERVICE-006" })
    })

    it("refuses a grant for a use the cognet does not declare, and a limit in money", async () => {
        await expect(Grants({ blueprint: blueprint({ depth: { ...DEPTH, optional: true } }, { hearing: "auto" }, []) })).rejects.toThrow(/declares no use "hearing"/)
        const features = await provider("features", FEATURES_PROVIDER)
        await expect(Grants({ blueprint: blueprint({ features: FEATURES }, { features: { limit: { usd: 5, per: "day" } } }, [features]) })).rejects.toThrow(/usd limit is not wired yet/)
    })

    it("hands a provider the machine's engines it asked for, as this.engines", async () => {
        const features = await provider("features", `export default defineProvider({
    implements: "@cody/terry/features@1",
    engines: { dino: { type: "transform", in: "image", out: "features" } },
    describe: () => ({ patch: 16 }),
    async extract(picture, patch) { return this.engines.dino.transform({ width: picture.width, patch: patch }) },
})
`, { dino: { type: "transform", in: ["image"], out: ["features"] } })
        const dino = { kind: "transform" as const, transform: async (input: unknown) => ({ seen: input }) }
        const engines = { has: (role: string) => role === "./providers/features/dino", get: () => ({ driver: dino }) } as unknown as EnginesT
        const grants = await Grants({ blueprint: blueprint({ features: FEATURES }, undefined, [features]), engines: engines })
        expect(await grants.granted("features")!.call("extract", { picture: { width: 64 }, patch: 16 })).toEqual({ seen: { width: 64, patch: 16 } })
    })

    it("refuses a provider whose engines the machine cannot serve", async () => {
        const features = await provider("features", FEATURES_PROVIDER, { dino: { type: "transform", in: ["image"], out: ["features"] } })
        await expect(Grants({ blueprint: blueprint({ features: FEATURES }, undefined, [features]) })).rejects.toThrow(/needs a dino engine, and nothing this machine has can serve it/)
    })

    it("serves a standard interface through the engine bound to the use: the picture across, the answer back as memory", async () => {
        const seen: unknown[] = []
        const driver = {
            kind: "transform" as const,
            async transform(input: unknown) {
                seen.push(input)
                return { kind: "depth", depth: { kind: "tensor", dims: [1, 2], dtype: "float32", data: Buffer.from(new Float32Array([0.25, 0.5]).buffer).toString("base64") } }
            },
        }
        const engines = {
            has: (role: string) => role === "depth",
            get: () => ({ driver: driver, binding: { requirement: { type: "transform" }, capability: { provider: "local", id: "depth-anything-v2-small", in: ["image"], out: ["depth"] }, slots: 1 } }),
        } as unknown as EnginesT
        const grants = await Grants({ blueprint: blueprint({ depth: DEPTH }, undefined, []), engines: engines })
        const granted = grants.granted("depth")!
        expect(granted.name).toBe("local:depth-anything-v2-small")
        const answer = await granted.call("estimate", { picture: { width: 2, height: 1, rgb: new Uint8Array([1, 2, 3, 4, 5, 6]) } }) as { width: number; height: number; nearness: Float32Array }
        expect(seen[0]).toMatchObject({ kind: "image", width: 2, height: 1, channels: 3 })
        expect({ width: answer.width, height: answer.height, nearness: [...answer.nearness] }).toEqual({ width: 2, height: 1, nearness: [0.25, 0.5] })
    })

    it("admits an engine that doesn't report what the use requires, as the resolver did — unknown, not unmet", async () => {
        const driver = { kind: "generate" as const, async *stream() {} }
        const engines = {
            has: (role: string) => role === "main",
            get: () => ({ driver: driver, binding: { requirement: { type: "generate" }, capability: { provider: "codex", id: "gpt-5.6", in: ["text"], out: ["text"] }, slots: 1 } }),
        } as unknown as EnginesT
        const main: CognetUse = { interface: "chat@1", named: "chat@1", requires: { context: { min: 128_000 } }, methods: { describe: { kind: "describe", params: [] } } }
        const grants = await Grants({ blueprint: blueprint({ main: main }, undefined, []), engines: engines })
        expect(grants.granted("main")!.name).toBe("codex:gpt-5.6")
    })

    it("reports no more slots than the use would use at once", async () => {
        const driver = { kind: "generate" as const, async *stream() {} }
        const engines = {
            has: (role: string) => role === "small",
            get: () => ({ driver: driver, binding: { requirement: { type: "generate" }, capability: { provider: "axon", id: "google/gemini-2.5-flash", in: ["text"], out: ["text"] }, slots: 8 } }),
        } as unknown as EnginesT
        const small: CognetUse = { interface: "chat@1", named: "chat@1", parallel: 4, methods: { describe: { kind: "describe", params: [] } } }
        const grants = await Grants({ blueprint: blueprint({ small: small }, undefined, []), engines: engines })
        expect(grants.granted("small")!.describe()).toMatchObject({ slots: 4 })
    })
})

describe("engineRoles", () => {
    const CHAT: CognetUse = { interface: "chat@1", named: "chat@1", requires: { context: { min: 100_000 } }, methods: { describe: { kind: "describe", params: [] }, request: { kind: "call", params: ["conversation"] } } }

    it("asks the engines for a role per use of a standard interface, and pins the routes granted by name", () => {
        const uses = { main: CHAT, depth: { ...DEPTH, optional: true }, features: FEATURES }
        const roles = engineRoles(uses, granted(uses, { main: "anthropic:claude-sonnet-5-5" }))
        expect(roles.requirements).toEqual({
            main: { type: "generate", in: ["text"], out: ["text"], context: 100_000 },
            depth: { type: "transform", in: ["image"], out: ["depth"], optional: true },
        })
        expect(roles.pins).toEqual({ main: "anthropic:claude-sonnet-5-5" })
    })

    it("carries what every use decides alike: its models as a list, its primary, and whether it fans out", () => {
        const uses = {
            voice: { ...CHAT, primary: true },
            small: { ...CHAT, requires: undefined, model: ["google/gemini-2.5-flash", "anthropic/claude-haiku-4.5"], parallel: 4, optional: true },
            jev: { ...CHAT, requires: undefined, model: "acme/jev-1" },
        }
        expect(engineRoles(uses, granted(uses, undefined)).requirements).toEqual({
            voice: { type: "generate", in: ["text"], out: ["text"], context: 100_000, primary: true },
            small: { type: "generate", in: ["text"], out: ["text"], model: ["google/gemini-2.5-flash", "anthropic/claude-haiku-4.5"], parallel: true, optional: true },
            jev: { type: "generate", in: ["text"], out: ["text"], model: ["acme/jev-1"] },
        })
    })

    it("refuses a model named for an interface no engine serves", () => {
        const uses = { features: { ...FEATURES, model: "facebook/dinov3" } }
        expect(() => engineRoles(uses, granted(uses, undefined))).toThrow(/features names a model, but @cody\/terry\/features@1 is not served by any engine/)
    })

    it("asks nothing for a use granted off, or to the agent's own provider", () => {
        const uses = { main: CHAT, depth: DEPTH }
        expect(engineRoles(uses, granted(uses, { main: "off", depth: "./providers/depth" })).requirements).toEqual({})
    })

    it("refuses a route granted to an interface no engine serves", () => {
        const uses = { features: FEATURES }
        expect(() => engineRoles(uses, granted(uses, { features: "local:dinov3" }))).toThrow(/only a provider the agent writes can serve it/)
    })
})
