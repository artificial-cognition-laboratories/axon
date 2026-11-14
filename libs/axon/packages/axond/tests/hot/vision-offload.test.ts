import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorMap } from "@arcforge/err"
import { Offload, type VisionTask } from "../../src/models/vision"

/**
 * Weights loaded through Offload run on another thread, one at a time. The library is a
 * stand-in module the worker imports by path, as it imports the real one:
 * what is proven here is the thread boundary — placement, errors, lifetime —
 * not a model.
 */

const LIBRARY = `
import { threadId } from "node:worker_threads"
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims } }
export const env = {}
export { Tensor }
export const RawImage = class {}
export const AutoModel = {
    async from_pretrained(path) {
        if (path.includes("missing")) throw new Error("no such weight: " + path)
        const model = async () => ({ last_hidden_state: { dims: [1, 3, 3], data: Float32Array.of(9, 9, 9, 1, 2, 3, 4, 5, 6) } })
        model.dispose = async () => {}
        return model
    },
}
export const where = threadId
`

function fixture(): { library: string; weight: string } {
    const dir = mkdtempSync(join(tmpdir(), "axon-offload-"))
    const library = join(dir, "library.mjs")
    writeFileSync(library, LIBRARY)
    const weight = join(dir, "weight")
    require("node:fs").mkdirSync(weight)
    writeFileSync(join(weight, "config.json"), JSON.stringify({ patch_size: 16 }))
    writeFileSync(join(weight, "preprocessor_config.json"), JSON.stringify({ image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], rescale_factor: 1 / 255 }))
    return { library: library, weight: weight }
}

const image = (width: number, height: number) => ({ kind: "image" as const, width: width, height: height, channels: 3 as const, data: Buffer.alloc(width * height * 3, 255).toString("base64") })

const open: VisionTask[] = []
afterEach(async () => { await Promise.all(open.splice(0).map(task => task.dispose())) })

describe("vision offload", () => {
    it("answers a call from a worker thread, with the task's own result", async () => {
        const { library, weight } = fixture()
        const task = await Offload({ library: library }).load("image-feature-extraction", weight, "cpu")
        open.push(task)
        const out = await task.call(image(32, 16)) as { patch: number; grid: { dims: number[] } }
        expect(out.patch).toBe(16)
        expect(out.grid.dims).toEqual([1, 2, 3])
    })

    it("does not hold the calling thread while the weight works", async () => {
        const { library, weight } = fixture()
        const task = await Offload({ library: library }).load("image-feature-extraction", weight, "cpu")
        open.push(task)
        let ticks = 0
        const timer = setInterval(() => { ticks++ }, 1)
        await Promise.all(Array.from({ length: 20 }, () => task.call(image(32, 16))))
        clearInterval(timer)
        expect(ticks).toBeGreaterThan(0)
    })

    it("keeps an input fault's code across the thread boundary", async () => {
        const { library, weight } = fixture()
        const task = await Offload({ library: library }).load("image-feature-extraction", weight, "cpu")
        open.push(task)
        // 17 is not a multiple of the 16px patch: the task refuses it by code.
        const refused = await task.call(image(17, 16)).then(() => null, (cause: { code?: string; message: string }) => cause)
        expect(refused?.code).toBe(errorMap.MODEL_INPUT_INVALID.code)
        expect(refused?.message).toMatch(/patch/)
    })

    it("rejects a load that fails, and the worker still serves the next", async () => {
        const { library, weight } = fixture()
        const offload = Offload({ library: library })
        await expect(offload.load("image-feature-extraction", "/missing/weight", "cpu")).rejects.toThrow(/no such weight|missing/)
        const task = await offload.load("image-feature-extraction", weight, "cpu")
        open.push(task)
        expect((await task.call(image(32, 16)) as { patch: number }).patch).toBe(16)
    })

    it("fails a call to a disposed weight, and leaves the others running", async () => {
        const { library, weight } = fixture()
        const offload = Offload({ library: library })
        const gone = await offload.load("image-feature-extraction", weight, "cpu")
        const kept = await offload.load("image-feature-extraction", weight, "cpu")
        open.push(kept)
        await gone.dispose()
        const refused = await gone.call(image(32, 16)).then(() => null, (cause: { message: string }) => cause)
        expect(refused?.message).toMatch(/no vision weight/)
        expect((await kept.call(image(32, 16)) as { patch: number }).patch).toBe(16)
    })

    it("loads and calls several weights at once without overlapping them in the worker", async () => {
        const { library, weight } = fixture()
        const offload = Offload({ library: library })
        const tasks = await Promise.all([1, 2, 3].map(() => offload.load("image-feature-extraction", weight, "cpu")))
        open.push(...tasks)
        const outs = await Promise.all(tasks.flatMap(task => [task.call(image(32, 16)), task.call(image(32, 16))]))
        expect(outs).toHaveLength(6)
    })
})
