import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DepthMap, FeatureGrid, Masks } from "@arcforge/types"
import { Depth, Features, Segmenter, tensor, type VisionLibrary } from "../../src/models/vision"

/**
 * The vision tasks, against a stand-in library — what they do with a model's
 * tensors, not whether a GPU is present. The real models are proven by the
 * full suite; these pin the arithmetic that places a grid on an image and a
 * point on a square.
 */

const NORM = { image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], rescale_factor: 1 / 255 }

function repository(model: Record<string, unknown>, preprocessor: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "axon-vision-"))
    writeFileSync(join(dir, "config.json"), JSON.stringify(model))
    writeFileSync(join(dir, "preprocessor_config.json"), JSON.stringify({ ...NORM, ...preprocessor }))
    return dir
}

function image(width: number, height: number) {
    return { kind: "image" as const, width: width, height: height, channels: 3 as const, data: Buffer.alloc(width * height * 3, 255).toString("base64") }
}

class FakeTensor {
    constructor(public type: string, public data: Float32Array | BigInt64Array, public dims: number[]) {}
}

function library(forward: (inputs: Record<string, any>) => Record<string, { dims: number[]; data: ArrayLike<number> }>, seen: Array<Record<string, any>> = []): VisionLibrary {
    const model = Object.assign(async (inputs: Record<string, any>) => { seen.push(inputs); return forward(inputs) }, {
        get_image_embeddings: async () => ({ "image_embeddings.0": { dims: [1], data: [0] } }),
        dispose: async () => {},
    })
    return {
        AutoModel: { from_pretrained: async () => model },
        Tensor: FakeTensor as never,
        RawImage: class {
            constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
            async resize(width: number, height: number) { return { data: new Uint8ClampedArray(width * height * 3), width: width, height: height, channels: 3 } }
        } as never,
    }
}

describe("vision — features", () => {
    it("returns the LAST rows×cols tokens as a grid at the image's own size", async () => {
        // A 32×16 image in 16px patches is 2×1 cells; the model returns a
        // summary token first, then the two patch tokens, 3 values each.
        const path = repository({ patch_size: 16 })
        const task = await Features.load(library(() => ({ last_hidden_state: { dims: [1, 3, 3], data: Float32Array.of(9, 9, 9, 1, 2, 3, 4, 5, 6) } })), path, "cpu")
        const out = await task.call(image(32, 16)) as FeatureGrid
        expect(out.patch).toBe(16)
        expect(out.grid.dims).toEqual([1, 2, 3])
        expect(Array.from(new Float32Array(Buffer.from(out.grid.data, "base64").buffer.slice(0)))).toEqual([1, 2, 3, 4, 5, 6])
    })

    it("normalises pixels as the repository says, channels first", async () => {
        const seen: Array<Record<string, any>> = []
        const path = repository({ patch_size: 16 })
        const task = await Features.load(library(() => ({ last_hidden_state: { dims: [1, 1, 1], data: Float32Array.of(0) } }), seen), path, "cpu")
        await task.call(image(16, 16))
        const pixels = seen[0]!.pixel_values as FakeTensor
        expect(pixels.dims).toEqual([1, 3, 16, 16])
        // White: 255/255 = 1, less 0.5, over 0.5.
        expect(pixels.data[0]).toBeCloseTo(1)
    })

    it("refuses an image that does not tile into patches, rather than cropping it", async () => {
        const task = await Features.load(library(() => ({})), repository({ patch_size: 16 }), "cpu")
        await expect(task.call(image(30, 16))).rejects.toThrow(/multiples of 16/)
    })
})

describe("vision — masks", () => {
    it("scales each point onto SAM's square and keeps the proposal it rates best", async () => {
        const seen: Array<Record<string, any>> = []
        // Three 2×2 proposals; the second is rated best and covers one cell.
        const logits = Float32Array.of(1, 1, 1, 1, 5, -1, -1, -1, -1, -1, -1, -1)
        const lib = library(() => ({
            pred_masks: { dims: [1, 1, 3, 2, 2], data: logits },
            iou_scores: { dims: [1, 1, 3], data: Float32Array.of(0.2, 0.9, 0.1) },
            object_score_logits: { dims: [1, 1, 1], data: Float32Array.of(20) },
        }), seen)
        const task = await Segmenter.load(lib, repository({ model_type: "sam2" }), "cpu")
        const out = await task.call({ kind: "segment", image: image(1280, 720), points: [{ x: 640, y: 360 }] }) as Masks

        const points = seen.find(inputs => inputs.input_points)!.input_points as FakeTensor
        expect(Array.from(points.data as Float32Array)).toEqual([512, 512])
        expect(out.masks).toHaveLength(1)
        expect(Array.from(Buffer.from(out.masks[0]!.mask.data, "base64"))).toEqual([1, 0, 0, 0])
        expect(out.masks[0]!.score).toBeCloseTo(0.9)
    })

    it("refuses a call that is not a SegmentInput", async () => {
        const task = await Segmenter.load(library(() => ({})), repository({ model_type: "sam2" }), "cpu")
        await expect(task.call(image(8, 8))).rejects.toThrow(/SegmentInput/)
    })
})

describe("vision — depth", () => {
    const WORKING = { size: { height: 28, width: 28 }, ensure_multiple_of: 14 }

    it("runs the image at the model's working size, aspect kept, and answers at that size", async () => {
        const seen: Array<Record<string, any>> = []
        // 112×56 with a longer side of 28 is 28×14: two patches by one.
        const lib = library(() => ({ predicted_depth: { dims: [1, 14, 28], data: new Float32Array(14 * 28).fill(2) } }), seen)
        const task = await Depth.load(lib, repository({ model_type: "depth_anything" }, WORKING), "cpu")
        const out = await task.call(image(112, 56)) as DepthMap

        expect((seen[0]!.pixel_values as FakeTensor).dims).toEqual([1, 3, 14, 28])
        expect(out.kind).toBe("depth")
        expect(out.depth.dims).toEqual([14, 28])
        expect(new Float32Array(Buffer.from(out.depth.data, "base64").buffer.slice(0))[0]).toBe(2)
    })

    it("refuses to load a repository that does not say what size it works at", async () => {
        await expect(Depth.load(library(() => ({})), repository({ model_type: "depth_anything" }), "cpu")).rejects.toThrow(/ensure_multiple_of/)
    })

    it("fails when the model returns no depth", async () => {
        const task = await Depth.load(library(() => ({})), repository({ model_type: "depth_anything" }, WORKING), "cpu")
        await expect(task.call(image(28, 28))).rejects.toThrow(/predicted_depth/)
    })
})

describe("vision — tensors", () => {
    it("refuses a tensor whose values disagree with its dims", () => {
        expect(() => tensor.encode(new Float32Array(5), [2, 3])).toThrow(/cannot have dims/)
    })
})
