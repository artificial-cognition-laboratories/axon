import type { AxonBlueprint } from "../blueprint"
import type { KernelAbi, CognetWake } from "../kernel/abi"
import type { AxonEntryEvent } from "../session/events/entries"

/**
 * A cognet definition — one cognition artifact, what defineCognet()
 * produces. Built as its own project (registry/cognets/*), bundled by the CLI, and
 * carried into the runtime on blueprint.cognet — there is NO other way to
 * load a brain. Resident for the runtime's lifetime: the kernel loads it
 * once (exec), delivers wakes, and owns the execution record around every
 * wake.
 *
 * The definition owns everything inside: grammar, context rendering,
 * strategy, its own derived state (a cache of the log, rebuildable — never
 * authoritative). It touches nothing but the ABI it receives at load().
 */
/**
 * How the scheduler decides to invoke this cognet. Part of the cognet's own
 * declared identity — never blueprint-overridable, same trust direction as
 * `abi`: a cognet built for invocation-based wakes was never written to
 * tolerate an empty-stimuli tick, so an agent author can't flip this from
 * outside.
 *
 * - "invocation" — invoked once per admitted stimulus arrival, handed the
 *   full diff accumulated since the last invocation (may be more than one
 *   stimulus if several arrived while the previous wake was running).
 * - "continuous" — invoked by a clock the BODY owns, regardless of whether
 *   anything arrived; an empty diff is the ordinary steady state, not an
 *   edge case.
 *
 * Continuous carries no rate. It declares the SHAPE of the cognet — "tick
 * me, don't hand me a chat prompt" — which is what `stream()` and `tick()`
 * reject against, and nothing more. A `tickMs` lived here once and was
 * wrong in the same way a `salience` field on a stimulus is wrong: it had
 * the brain asserting how fast its world turns, which it cannot know and
 * must never assume. The rate lives with whatever drives `axon.tick()`.
 */
export type CognetSchedule =
    | { kind: "invocation" }
    | { kind: "continuous" }

/**
 * Cognet identity — what cognet.config.ts declares via defineCognet().
 * The compiled artifact composes this with the loop the entry script
 * registers; identity and behavior never live in the same file.
 */
export type CognetConfig = {
    name: string
    version: string

    /** The kernel ABI version this cognet was built against — checked at load, mismatch refuses loudly. */
    abi: string

    /** How the scheduler invokes this cognet. */
    mode: CognetSchedule

    /** Default wake mask — overridable by the blueprint's wakeOn. Absent = wake on everything. */
    wakeOn?: Array<keyof AxonEntryEvent>

    /** Hard safety bound for one wake. Strategy may stop earlier; default is 8 ticks. */
    maxTicksPerWake?: number

    /**
     * Model weights this brain needs, by the name IT calls them.
     *
     * ```ts
     * models: {
     *     vad: "hf:runanywhere/silero-vad-v5/silero_vad.onnx",
     *     asr: "hf:ggerganov/whisper.cpp/ggml-base.en.bin",
     * }
     * ```
     *
     * Weights are DATA, not code — a `.onnx` file is inert until something
     * reads it. The runtime that executes it (onnxruntime, llama.cpp) is an
     * ordinary npm dependency the cognet imports, chosen by the author. This
     * field only says which bytes are needed; how to run them is cognition.
     *
     * That is also why there is no unified `runModel()`: every model has its
     * own tensor signature, so a generic invoke could only pass `unknown`
     * through. Acquisition collapses to one mechanism; inference cannot.
     *
     * A MAP, not a list, because the key is the brain's own vocabulary.
     * `kernel.models.vad` says what the weight is FOR; the specifier says
     * where it came from. Swapping to a different VAD is one line here rather
     * than an edit at every call site — and a brain that referenced its
     * supply chain at every use would have learned something it does not
     * need to know.
     *
     * Axon fetches, verifies and caches these; the resolved paths arrive at
     * load through `kernel.models`, never read from this config. A path is
     * environmental, and a cognet learns nothing about its environment except
     * through the kernel.
     */
    models?: Record<string, ModelRef>
}

/**
 * Where a weight comes from.
 *
 * `"hf:owner/repo/path/to/file.onnx"` is the short form and covers almost
 * everything. The object form exists for the two things a string cannot
 * carry: a revision pin, and an expected hash.
 *
 * `sha256` is the difference between "verified" and "verified against
 * something I chose". Without it, first fetch is trust-on-first-use — the
 * bytes that arrived become the bytes that are correct forever. With it, a
 * compromised or silently-replaced upstream file fails loudly.
 */
export type ModelRef =
    | string
    | {
        /** `owner/repo` on Hugging Face. */
        hf: string
        /** Path within the repo — a repo is a directory, and repos hold many weights. */
        file: string
        /** Git revision. Defaults to `main`. */
        rev?: string
        /** Expected content hash. Pin it and a changed upstream is an error, not a surprise. */
        sha256?: string
    }

export type CognetDefinition = CognetConfig & {

    /** exec(): receives the syscall table. Runs once, before any wake. */
    load(kernel: KernelAbi): Promise<void> | void

    /** One scheduled episode. Returns when quiescent; throws on failure. */
    wake(wake: CognetWake): Promise<void>

    /** The agent changed (hot reload) — adopt the new blueprint before the next wake. */
    update?(blueprint: AxonBlueprint): void

    /** Brain off. Nothing durable to flush — durable writes already happened at commit time. */
    unload?(): Promise<void> | void
}
