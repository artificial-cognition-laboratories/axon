import { err } from "@arcforge/err"
import type { FeatureGrid } from "@arcforge/types"
import { config } from "./config"
import { tensor } from "./tensor"
import type { Device, VisionLibrary, VisionTask } from "./types"

/**
 * Features — a vision encoder's patch descriptors, at the caller's own size.
 *
 * Not the `image-feature-extraction` pipeline: that resizes and crops to
 * what the encoder was trained at (224px for DINO) and hands back
 * descriptors of a different picture. A perception stack chooses its size so
 * the grid lines up with everything else it measures, so the image goes in
 * as sent — normalised exactly as the repository's preprocessor says — and
 * the patch tokens come out as a `[rows, cols, dim]` grid.
 *
 * Patch tokens are the LAST rows×cols tokens: a ViT puts its summary token
 * and any register tokens first. The count is checked, not assumed.
 */
export const Features = {
    async load(library: VisionLibrary, path: string, device: Device): Promise<VisionTask> {
        const model = await library.AutoModel.from_pretrained(path, { device: runtimeDevice(device), dtype: "fp32", local_files_only: true })
        const norm = config.normalization(path)
        const patch = config.model(path).patch_size
        if (typeof patch !== "number") throw err("MODEL_LOAD_FAILED", { detail: `${path} does not state a patch_size — its tokens cannot be placed on the image` })

        return {
            async call(input: unknown): Promise<FeatureGrid> {
                const image = tensor.rgb(input, "features")
                if (image.width % patch || image.height % patch) {
                    throw err("MODEL_INPUT_INVALID", { detail: `a ${image.width}×${image.height} image does not tile into ${patch}px patches — send sides that are multiples of ${patch}` })
                }
                const pixels = new library.Tensor("float32", tensor.normalize(image.bytes, image.width, image.height, norm), [1, 3, image.height, image.width])
                const out = await model({ pixel_values: pixels })
                const hidden = out.last_hidden_state
                if (!hidden || hidden.dims.length !== 3) throw err("MODEL_RUN_FAILED", { detail: `${path} returned no last_hidden_state` })
                const [, tokens, dim] = hidden.dims as [number, number, number]
                const rows = image.height / patch
                const cols = image.width / patch
                if (tokens < rows * cols) throw err("MODEL_RUN_FAILED", { detail: `${path} returned ${tokens} tokens for a ${cols}×${rows} patch grid` })
                const all = hidden.data as Float32Array
                const grid = all.slice((tokens - rows * cols) * dim)
                return { kind: "features", patch: patch, grid: tensor.encode(grid, [rows, cols, dim]) }
            },
            dispose: () => model.dispose(),
        }
    },
}

/** The library's name for a device. */
export function runtimeDevice(device: Device): string {
    return device === "gpu" ? "webgpu" : "cpu"
}
