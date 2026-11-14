import { describe, expect, it } from "bun:test"
import type { CognetUse, ProviderSession, ServiceProvider } from "@arcforge/types"
import { Services } from "../../src/services"

const SEGMENT: CognetUse = {
    interface: "segment@1",
    named: "segment@1",
    methods: {
        describe: { kind: "describe", params: [] },
        encode: { kind: "call", params: ["picture"] },
        mask: { kind: "call", params: ["encoded", "prompt"] },
    },
}

const CHAT: CognetUse = {
    interface: "chat@1",
    named: "chat@1",
    methods: {
        describe: { kind: "describe", params: [] },
        request: { kind: "call", params: ["conversation"] },
        stream: { kind: "stream", params: ["conversation"] },
    },
}

/** A provider that keeps one handle per encode, and remembers what it was asked and told to let go. */
function Provider(name: string) {
    const asked: Array<[string, Record<string, unknown>]> = []
    const released: string[] = []
    let kept = 0
    const provider: ServiceProvider = {
        name: name,
        describe: () => ({ maxSide: 1024 }),
        async call(method, args) {
            asked.push([method, { ...args }])
            if (method === "encode") return { handle: "Encoded", id: `${name}-${++kept}` }
            if (method === "request") throw new Error("the model is overloaded")
            return { score: 0.9 }
        },
        async *stream() {
            yield { text: "Hel" }
            yield { text: "lo" }
        },
        async open(): Promise<ProviderSession> {
            return { push: async value => value, reset: async () => {}, close: async () => {} }
        },
        async release(id) {
            released.push(id)
        },
    }
    return { provider: provider, asked: asked, released: released }
}

function services(granted: Record<string, ServiceProvider | null>) {
    const recorded: Array<[string, Record<string, unknown>]> = []
    const services = Services({
        uses: () => ({ segment: SEGMENT, main: CHAT }),
        grants: { granted: use => granted[use] ?? null },
        active: () => ({ runId: "run-1", signal: new AbortController().signal }),
        record: async (type, data) => { recorded.push([type, data]) },
    })
    return { services: services, recorded: recorded }
}

describe("Services", () => {
    it("reports each declared use as it stands — available, and what fills it reports", () => {
        const { services: served } = services({ segment: Provider("sam").provider })
        expect(served.state()).toEqual({
            segment: { available: true, describe: { maxSide: 1024 } },
            main: { available: false, describe: null },
        })
    })

    it("serves a call, recording it with the provider that answered", async () => {
        const sam = Provider("sam")
        const { services: served, recorded } = services({ segment: sam.provider })
        const encoded = await served.call("segment", "encode", { picture: { width: 1 } })
        expect(encoded).toMatchObject({ handle: "Encoded" })
        expect(recorded).toEqual([
            ["kernel:service:start", { use: "segment", method: "encode", kind: "call", provider: "sam" }],
            ["kernel:service:complete", { use: "segment", method: "encode" }],
        ])
    })

    it("gives the cognet its own id for a handle, and the provider its own back", async () => {
        const sam = Provider("sam")
        const { services: served } = services({ segment: sam.provider })
        const encoded = await served.call("segment", "encode", { picture: {} }) as { handle: string; id: string }
        expect(encoded.id).not.toBe("sam-1")
        await served.call("segment", "mask", { encoded: encoded, prompt: { point: [1, 2] } })
        expect(sam.asked[1]).toEqual(["mask", { encoded: { handle: "Encoded", id: "sam-1" }, prompt: { point: [1, 2] } }])
        await served.release(encoded.id)
        expect(sam.released).toEqual(["sam-1"])
        await expect(served.call("segment", "mask", { encoded: encoded, prompt: {} })).rejects.toMatchObject({ code: "AX-SERVICE-005" })
    })

    it("ends a handle when the provider behind its use changes — never a quietly different answer", async () => {
        const granted: Record<string, ServiceProvider | null> = { segment: Provider("sam").provider }
        const { services: served } = services(granted)
        const encoded = await served.call("segment", "encode", { picture: {} })
        granted.segment = Provider("sam2").provider
        await expect(served.call("segment", "mask", { encoded: encoded, prompt: {} })).rejects.toThrow(/provider behind segment has changed/)
    })

    it("refuses what the interface does not allow, before any provider is reached", async () => {
        const sam = Provider("sam")
        const { services: served } = services({ segment: sam.provider })
        await expect(served.call("depth", "estimate", {})).rejects.toMatchObject({ code: "AX-SERVICE-004" })
        await expect(served.call("segment", "explode", {})).rejects.toThrow(/segment@1 has no method explode/)
        expect(() => served.stream("segment", "encode", {})).toThrow(/encode is a call, not a stream/)
        await expect(served.call("main", "request", {})).rejects.toMatchObject({ code: "AX-SERVICE-001" })
        expect(sam.asked).toEqual([])
    })

    it("fails a call the provider fails, with its reason, and records it", async () => {
        const { services: served, recorded } = services({ main: Provider("claude").provider })
        await expect(served.call("main", "request", { conversation: {} })).rejects.toMatchObject({ code: "AX-SERVICE-003" })
        expect(recorded.at(-1)![0]).toBe("kernel:service:failed")
    })

    it("streams answers, and records a reader leaving early as interrupted, not failed", async () => {
        const { services: served, recorded } = services({ main: Provider("claude").provider })
        const written: unknown[] = []
        for await (const event of served.stream("main", "stream", { conversation: {} })) {
            written.push(event)
            break
        }
        expect(written).toEqual([{ text: "Hel" }])
        expect(recorded.map(([type]) => type)).toEqual(["kernel:service:start", "kernel:service:interrupted"])
        expect(recorded.at(-1)![1]).toEqual({ use: "main", method: "stream", events: 1 })
    })
})
