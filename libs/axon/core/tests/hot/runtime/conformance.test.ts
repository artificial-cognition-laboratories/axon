import { describe, expect, it } from "bun:test"
import { dirname, join } from "node:path"
import type { CognetUse, ServiceProvider } from "@arcforge/types"
import { Conformance } from "../../../src/runtime/services/conformance"

/** The standard library's cases, as the installed runtime ships them. */
const cases = (name: string) => join(dirname(Bun.resolveSync(`@arcforge/cognet/interfaces/${name}`, import.meta.dir)), `${name}.conformance`)

const DEPTH: CognetUse = { interface: "depth-relative@1", named: "depth-relative@1", methods: { describe: { kind: "describe", params: [] }, estimate: { kind: "call", params: ["picture"] } } }
const SEGMENT: CognetUse = { interface: "segment@1", named: "segment@1", methods: { describe: { kind: "describe", params: [] }, encode: { kind: "call", params: ["picture"] }, mask: { kind: "call", params: ["encoded", "prompt"] } } }

function provider(call: ServiceProvider["call"]): ServiceProvider {
    return { name: "test", describe: () => ({}), call: call, stream: () => { throw new Error("no streams") }, open: () => Promise.reject(new Error("no sessions")), release: async () => {} }
}

describe("Conformance", () => {
    it("passes a provider that answers as depth-relative@1 says", async () => {
        const depth = provider(async (_method, args) => {
            const picture = args.picture as { width: number; height: number; rgb: Uint8Array }
            expect(picture.rgb).toBeInstanceOf(Uint8Array)
            const width = picture.width / 8, height = picture.height / 8
            return { width: width, height: height, nearness: new Float32Array(width * height).fill(0.5) }
        })
        const outcomes = await Conformance({ use: DEPTH, provider: depth, dir: cases("depth-relative@1") }).run()
        expect(outcomes.every(one => one.passed)).toBe(true)
    })

    it("fails one whose grid does not cover the picture, saying how", async () => {
        const depth = provider(async () => ({ width: 4, height: 3, nearness: new Float32Array(10) }))
        const [first] = await Conformance({ use: DEPTH, provider: depth, dir: cases("depth-relative@1") }).run()
        expect(first!.passed).toBe(false)
        expect(first!.problems).toEqual(["nearness.length is 10, not 12"])
    })

    it("feeds one call's answer to the next, and checks every value of a mask once", async () => {
        const asked: string[] = []
        const segment = provider(async (method, args) => {
            asked.push(method)
            if (method === "encode") return { handle: "Encoded", id: "1" }
            expect(args.encoded).toEqual({ handle: "Encoded", id: "1" })
            return { width: 2, height: 2, mask: Uint8Array.from([0, 1, 2, 3]), score: 1.5 }
        })
        const [outcome] = await Conformance({ use: SEGMENT, provider: segment, dir: cases("segment@1") }).run()
        expect(asked).toEqual(["encode", "mask"])
        expect(outcome!.problems).toEqual(["mask[2] is 2, not one of [0,1] (and 1 more)", "score is 1.5, above 1"])
    })

    it("reports a provider that throws as a failed case, not a crashed run", async () => {
        const broken = provider(async () => { throw new Error("out of memory") })
        const outcomes = await Conformance({ use: DEPTH, provider: broken, dir: cases("depth-relative@1") }).run()
        expect(outcomes.map(one => one.problems[0])).toEqual(["it failed: out of memory", "it failed: out of memory"])
    })
})
