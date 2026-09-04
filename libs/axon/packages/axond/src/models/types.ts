import type { EngineType, Modality } from "@arcforge/types"
import type { Download } from "./downloads"

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
export type ModelRuntime = "onnx" | "llama.cpp" | "transformers" | "ollama"

/**
 * What a model is FOR, in the vocabulary a person browsing would use.
 *
 * Distinct from `EngineType`, which is the execution shape — generate,
 * transform, stream — and answers how the kernel drives a weight rather than
 * what someone wants it for. A person looking for speech recognition is not
 * looking for "transform", and every ONNX export is one.
 *
 * Derived from the registry's own task tag, so it is a reading of what the
 * publisher declared rather than a guess from the name. "other" is a real
 * answer: a repository with no task tag, or one we have no bucket for, must
 * not be filed under a capability it may not have.
 */
export type ModelCapability = "chat" | "speech" | "embedding" | "vision" | "other"

/**
 * Whether this machine could actually run the weight.
 *
 * The primary ranking signal for a LOCAL browser, and the thing that separates
 * one from a registry page. Popularity is the right proxy for value when
 * anything on the list is runnable; here the best model in existence is worth
 * nothing if it needs a hundred gigabytes of video memory this box does not
 * have. A default list led by a 1.4TB model on an 11GB card is not a ranking,
 * it is a catalogue.
 *
 * "unknown" is a real answer and must not be treated as "fits": a Hugging Face
 * listing carries no size, so most rows genuinely cannot be judged until their
 * detail is fetched.
 */
export type ModelFit = "fits" | "tight" | "over" | "unknown"

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
    /** What the model is for, in a browsing vocabulary. See ModelCapability. */
    capability: ModelCapability
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
    /**
     * Whether it fits the ceiling in force — the declared budget, or the card.
     *
     * Computed against the machine at the moment of the answer, so the same
     * model reads differently on a different box. That is the point of it.
     */
    fit: ModelFit
    /**
     * The size the fit was judged against, when it had to be inferred.
     *
     * Null when `bytes` was known outright. A listing publishes no size, so a
     * parameter count read out of the name is often the only estimate there
     * is — carried separately from `bytes` so nothing mistakes a guess for a
     * measurement.
     */
    estimatedBytes: number | null
    description: string | null
    downloads: number | null
    /** Stars, where the registry keeps them. Ollama publishes none. */
    likes: number | null
    /**
     * When the registry last saw it change, epoch ms.
     *
     * A listing reports when a repository was CREATED and the detail call
     * reports when it was last modified; both land here because "how recent is
     * this" is one question and carrying two fields to answer it would mean
     * every consumer picking between them.
     */
    updatedAt: number | null
}

/** Everything the domain reports in one read. */
export type ModelsState = {
    /**
     * Transfers in flight, and ones that recently ended.
     *
     * Part of STATE rather than something a caller polls separately, so a
     * surface watching the machine sees a download appear, advance and finish
     * without asking a second question.
     */
    downloads: Download[]
    /** Every weight this machine has fetched. */
    cached: ModelRecord[]
    /** Every weight currently loaded, with what is holding it. */
    resident: ModelRecord[]
    /** Where the cache lives. Diagnostics — "where did my disk go" is otherwise unanswerable. */
    root: string
}
