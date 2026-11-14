import { err } from "@arcforge/err"
import type { ImageInput, TensorOutput } from "@arcforge/types"

/**
 * Pixels and tensors across the socket — plain functions, no runtime.
 *
 * Both directions are base64 bytes, never JSON arrays: a 1024×576 image is
 * 1.7MB of RGB and a feature grid is 3.5MB of float32, and as JSON numbers
 * either would be several times that to write and to parse.
 */
export const tensor = {
    /** A typed array as a `TensorOutput`, little-endian. */
    encode(values: Float32Array | Uint8Array, dims: number[]): TensorOutput {
        const expected = dims.reduce((product, size) => product * size, 1)
        if (values.length !== expected) throw err("MODEL_RUN_FAILED", { detail: `a tensor of ${values.length} values cannot have dims [${dims.join(", ")}]` })
        return {
            kind: "tensor",
            dims: dims,
            dtype: values instanceof Float32Array ? "float32" : "uint8",
            data: Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64"),
        }
    },

    /** An `ImageInput`'s RGB bytes, after checking it is one. */
    rgb(input: unknown, task: string): { width: number; height: number; bytes: Uint8Array } {
        const image = input as Partial<ImageInput> | null
        if (image?.kind !== "image" || typeof image.width !== "number" || typeof image.height !== "number" || image.channels !== 3 || typeof image.data !== "string") {
            throw err("MODEL_INPUT_INVALID", { detail: `${task} expects an ImageInput { kind: "image", width, height, channels: 3, data: base64 }`, context: { task: task } })
        }
        const bytes = Buffer.from(image.data, "base64")
        if (bytes.length !== image.width * image.height * 3) {
            throw err("MODEL_INPUT_INVALID", { detail: `ImageInput holds ${bytes.length} bytes, expected ${image.width}×${image.height}×3`, context: { task: task } })
        }
        return { width: image.width, height: image.height, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
    },

    /**
     * RGB bytes as a normalised channels-first float image, the way the
     * model's own preprocessor config says: `rescale`, then less `mean`,
     * over `std`, per channel.
     */
    normalize(rgb: Uint8Array, width: number, height: number, norm: Normalization): Float32Array {
        const plane = width * height
        const out = new Float32Array(3 * plane)
        for (let pixel = 0; pixel < plane; pixel++) {
            for (let channel = 0; channel < 3; channel++) {
                out[channel * plane + pixel] = (rgb[pixel * 3 + channel]! * norm.rescale - norm.mean[channel]!) / norm.std[channel]!
            }
        }
        return out
    },
}

/** How a model wants its pixels scaled, read from its `preprocessor_config.json`. */
export type Normalization = { rescale: number; mean: [number, number, number]; std: [number, number, number] }
