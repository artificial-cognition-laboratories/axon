import { err } from "@arcforge/err"
import type { Masks, SegmentInput } from "@arcforge/types"
import { config } from "./config"
import { runtimeDevice } from "./features"
import { tensor } from "./tensor"
import type { Device, LibraryTensor, VisionLibrary, VisionTask } from "./types"

/** The square SAM 2 sees every image as. Its masks come back a quarter of it. */
const SIDE = 1024

/**
 * Segmenter — a region at each point, from a promptable segmenter (SAM 2).
 *
 * The image is encoded ONCE and every point decodes against that encoding,
 * which is the whole economy of SAM: the encoder is the expensive half. The
 * preprocessor is not used per point either — it would resize the image
 * again for every prompt — so points are scaled here, the same way it would.
 *
 * SAM 2 squashes the image to a square without keeping its aspect, so a mask
 * covers the WHOLE image. Of the three masks it proposes per point, the one
 * it rates best is kept; its score is that rating times the model's belief
 * that anything is there at all.
 */
export const Segmenter = {
    async load(library: VisionLibrary, path: string, device: Device): Promise<VisionTask> {
        const model = await library.AutoModel.from_pretrained(path, { device: runtimeDevice(device), dtype: "fp32", local_files_only: true })
        if (!model.get_image_embeddings) throw err("MODEL_LOAD_FAILED", { detail: `${path} cannot encode an image once for many prompts` })
        const encode = model.get_image_embeddings.bind(model)
        const norm = config.normalization(path)

        return {
            async call(input: unknown): Promise<Masks> {
                const request = input as Partial<SegmentInput> | null
                if (request?.kind !== "segment" || !Array.isArray(request.points)) {
                    throw err("MODEL_INPUT_INVALID", { detail: "masks expects a SegmentInput { kind: \"segment\", image, points: [{ x, y }] }" })
                }
                const image = tensor.rgb(request.image, "masks")
                const square = await new library.RawImage(new Uint8ClampedArray(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength), image.width, image.height, 3).resize(SIDE, SIDE)
                const rgb = new Uint8Array(square.data.buffer, square.data.byteOffset, square.data.byteLength)
                const pixels = new library.Tensor("float32", tensor.normalize(rgb, SIDE, SIDE, norm), [1, 3, SIDE, SIDE])
                const embeddings = await encode({ pixel_values: pixels })

                const masks: Masks["masks"] = []
                for (const point of request.points) {
                    const out = await model({
                        ...embeddings,
                        input_points: new library.Tensor("float32", Float32Array.of(point.x * SIDE / image.width, point.y * SIDE / image.height), [1, 1, 1, 2]),
                        input_labels: new library.Tensor("int64", BigInt64Array.of(1n), [1, 1, 1]),
                    })
                    masks.push(best(out.pred_masks, out.iou_scores, out.object_score_logits, path))
                }
                return { kind: "masks", masks: masks }
            },
            dispose: () => model.dispose(),
        }
    },
}

/** The proposal the model rates highest, as 0/1 over the image. */
function best(logits: LibraryTensor | undefined, scores: LibraryTensor | undefined, present: LibraryTensor | undefined, path: string): Masks["masks"][number] {
    if (!logits || !scores || logits.dims.length !== 5) throw err("MODEL_RUN_FAILED", { detail: `${path} returned no pred_masks / iou_scores` })
    const [, , proposals, rows, cols] = logits.dims as [number, number, number, number, number]
    let pick = 0
    for (let index = 1; index < proposals; index++) if (scores.data[index]! > scores.data[pick]!) pick = index
    const plane = rows * cols
    const mask = new Uint8Array(plane)
    for (let cell = 0; cell < plane; cell++) mask[cell] = logits.data[pick * plane + cell]! > 0 ? 1 : 0
    const there = present ? 1 / (1 + Math.exp(-present.data[0]!)) : 1
    return { mask: tensor.encode(mask, [rows, cols]), score: Math.max(0, Math.min(1, scores.data[pick]! * there)) }
}
