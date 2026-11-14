/**
 * The slice of `@huggingface/transformers` the vision tasks use.
 *
 * Declared locally for the reason the adapter declares its own: the package
 * is an OPTIONAL runtime, and a type import would make the build require
 * what the daemon deliberately does not.
 */
export type VisionLibrary = {
    AutoModel: { from_pretrained(path: string, opts: Record<string, unknown>): Promise<VisionModel> }
    Tensor: new (type: "float32" | "int64", data: Float32Array | BigInt64Array, dims: number[]) => LibraryTensor
    RawImage: new (data: Uint8ClampedArray, width: number, height: number, channels: number) => {
        resize(width: number, height: number): Promise<{ data: Uint8ClampedArray; width: number; height: number; channels: number }>
    }
}

export type LibraryTensor = { dims: number[]; data: ArrayLike<number> }

export type VisionModel = ((inputs: Record<string, unknown>) => Promise<Record<string, LibraryTensor>>) & {
    get_image_embeddings?(inputs: { pixel_values: LibraryTensor }): Promise<Record<string, LibraryTensor>>
    dispose(): Promise<void>
}

/** Where a weight runs. `gpu` is WebGPU — over Vulkan on Linux, no CUDA install. */
export type Device = "gpu" | "cpu"

/** One loaded vision model, as the adapter calls it. */
export type VisionTask = {
    call(input: unknown): Promise<unknown>
    dispose(): Promise<void>
}
