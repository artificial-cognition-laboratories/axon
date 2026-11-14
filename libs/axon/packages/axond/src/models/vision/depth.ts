import { err } from "@arcforge/err"
import type { DepthMap } from "@arcforge/types"
import { config } from "./config"
import { runtimeDevice } from "./features"
import { tensor } from "./tensor"
import type { Device, VisionLibrary, VisionTask } from "./types"

/**
 * Depth — how near each part of a picture is, from a monocular depth model
 * (Depth Anything).
 *
 * The image is resized to what the repository's preprocessor says the model
 * works at — its longer side at most `side`, aspect kept, both sides a
 * multiple of the model's patch — because depth is a claim about the whole
 * picture and costs by the pixel: at the caller's own size it would take
 * several times as long to say the same thing. The answer covers the whole
 * image at the size it was run at, and says so in its dims.
 *
 * The numbers are the model's own: relative, inverse, larger is nearer.
 * Nothing here turns them into distances — that takes knowing the camera.
 */
export const Depth = {
    async load(library: VisionLibrary, path: string, device: Device): Promise<VisionTask> {
        const model = await library.AutoModel.from_pretrained(path, { device: runtimeDevice(device), dtype: "fp32", local_files_only: true })
        const norm = config.normalization(path)
        const working = config.working(path)

        return {
            async call(input: unknown): Promise<DepthMap> {
                const image = tensor.rgb(input, "depth")
                const size = fit(image.width, image.height, working)
                const resized = size.width === image.width && size.height === image.height
                    ? image.bytes
                    : await shrink(library, image, size)
                const pixels = new library.Tensor("float32", tensor.normalize(resized, size.width, size.height, norm), [1, 3, size.height, size.width])
                const out = await model({ pixel_values: pixels })
                const depth = out.predicted_depth
                if (!depth) throw err("MODEL_RUN_FAILED", { detail: `${path} returned no predicted_depth` })
                const [rows, cols] = depth.dims.slice(-2) as [number, number]
                if (depth.dims.length < 2 || depth.dims.slice(0, -2).some(extent => extent !== 1)) {
                    throw err("MODEL_RUN_FAILED", { detail: `${path} returned depth of dims [${depth.dims.join(", ")}] for one image` })
                }
                return { kind: "depth", depth: tensor.encode(Float32Array.from(depth.data), [rows, cols]) }
            },
            dispose: () => model.dispose(),
        }
    },
}

/** The size an image is run at: longer side at most `side`, aspect kept, each side the nearest multiple of `multiple` and at least one. */
function fit(width: number, height: number, working: { side: number; multiple: number }): { width: number; height: number } {
    const scale = Math.min(1, working.side / Math.max(width, height))
    const snap = (extent: number) => Math.max(working.multiple, Math.round(extent * scale / working.multiple) * working.multiple)
    return { width: snap(width), height: snap(height) }
}

async function shrink(library: VisionLibrary, image: { width: number; height: number; bytes: Uint8Array }, size: { width: number; height: number }): Promise<Uint8Array> {
    const raw = new library.RawImage(new Uint8ClampedArray(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength), image.width, image.height, 3)
    const out = await raw.resize(size.width, size.height)
    return new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength)
}
