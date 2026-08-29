import type { EngineType, Modality } from "@arcforge/types"

/**
 * What the models domain answers about.
 *
 * Three states a weight can be in, and they are genuinely different questions:
 *
 *   catalogued  it EXISTS somewhere — a registry has it, nothing local
 *   cached      the bytes are ON THIS DISK, costing disk and nothing else
 *   resident    it is LOADED, costing memory, and something is holding it
 *
 * A panel that collapsed cached and resident would make "unload" and "delete"
 * the same gesture, and the difference between them is the whole reason the
 * machine domain accounts for holds separately from disk.
 */

/** Where a weight comes from. Decides how it is fetched, never how it runs. */
export type ModelSource = "huggingface" | "ollama"

/**
 * How a weight is EXECUTED.
 *
 * The adapter axis. A `.onnx` file and a GGUF quantisation are both "a model"
 * and share nothing about how they are run — one needs an ONNX session, the
 * other a llama.cpp context — so the runtime is named on the record rather
 * than guessed from the extension at load time.
 */
export type ModelRuntime = "onnx" | "llama.cpp" | "ollama"

/** One weight, wherever it currently is. */
export type ModelRecord = {
    /** The specifier — `hf:onnx-community/whisper-base.en`, `ollama:qwen2.5-coder:7b`. */
    id: string
    /** Display name: the last meaningful segment. */
    name: string
    /** Publisher or org. */
    owner: string
    source: ModelSource
    /**
     * Which adapter can run this, or null when nothing here can.
     *
     * NULL IS A REAL ANSWER. A weight this machine can fetch and cannot
     * execute is a coherent state — the file is on disk and no adapter claims
     * it — and reporting a runtime we do not have would move that failure from
     * "download refused" to "load crashed".
     */
    runtime: ModelRuntime | null
    /** What the model is FOR, in the kernel's own vocabulary. */
    type: EngineType
    in: Modality[]
    out: Modality[]
    /** Bytes on disk. Null when only a catalogue entry knows of it. */
    bytes: number | null
    /**
     * Absolute path to the weight, when it is on this machine.
     *
     * Carried because LOADING needs it and nothing else can derive it: the
     * file is content-addressed, so its path is a hash the caller has no way
     * to compute from a specifier. Null for a catalogue entry that has not
     * been fetched — there is no file to name.
     */
    path: string | null
    /** True when the bytes are on this machine. */
    cached: boolean
    /** True when it is loaded and holding memory. */
    resident: boolean
    description: string | null
    downloads: number | null
}

/** Everything the domain reports in one read. */
export type ModelsState = {
    /** Every weight this machine has fetched. */
    cached: ModelRecord[]
    /** Every weight currently loaded, with what is holding it. */
    resident: ModelRecord[]
    /** Where the cache lives. Diagnostics — "where did my disk go" is otherwise unanswerable. */
    root: string
}
