import { err } from "@arcforge/err"
import type { ModelRuntime } from "./types"

/**
 * A loaded weight, as the daemon holds it.
 *
 * Opaque by design. The daemon knows a model is resident, how many bytes it
 * cost and who is holding it; what a session OBJECT is belongs to the adapter
 * that made it. That ignorance is what lets a second runtime land without the
 * residency accounting learning anything new.
 */
export type LoadedWeight = {
    /** Bytes this actually cost, measured after loading rather than promised before. */
    bytes: number
    /**
     * Run one inference against it.
     *
     * `unknown` in, `unknown` out: an ASR call takes audio and returns a
     * transcript, an embedder takes text and returns a vector, and the kernel
     * already refuses to interpret either — see Modality, which exists to
     * MATCH a model to a role rather than to describe a payload. An adapter
     * that typed this would be inventing a taxonomy the contract deliberately
     * does not have.
     */
    run(input: unknown): Promise<unknown>
    /** Release it. Idempotent — unloading twice is not an error. */
    unload(): Promise<void>
}

/**
 * What every runtime must be able to do.
 *
 * ── Why an adapter layer at all ─────────────────────────────────────────────
 *
 * "The daemon can load any model" is only true if loading is not one function
 * with a switch in it. A `.onnx` file and a GGUF quantisation share nothing
 * about execution — different libraries, different memory models, different
 * ideas of what a session is — and a single loader would grow a branch per
 * format until the branches were the design.
 *
 * So a runtime is a NOUN that claims files and loads them, and the daemon
 * holds a list of them. Adding llama.cpp is adding an adapter, not editing
 * one; the residency accounting, the admission check and the panel above them
 * learn nothing.
 *
 * ── Claiming is explicit, never inferred ────────────────────────────────────
 *
 * `claims()` asks the adapter, rather than the daemon guessing from a file
 * extension. `.bin` is a GGUF, a PyTorch checkpoint and a whisper.cpp weight
 * depending on who wrote it, and a central extension table would be a second
 * place that has to know every format — drifting from the adapters that
 * actually parse them.
 */
export type ModelAdapter = {
    /** Which runtime this is, for the record and for a person reading a row. */
    readonly runtime: ModelRuntime

    /**
     * Can this adapter run the file at `path`?
     *
     * Cheap and honest: a header read at most, never a full parse. A false
     * here means "not mine", never "broken" — the next adapter is asked, and
     * a file nothing claims is reported as unrunnable rather than failed.
     */
    claims(path: string): boolean

    /**
     * Load it, and report what it cost.
     *
     * Throws on a file it claimed and cannot read. That distinction matters:
     * refusing to claim is a routing answer, failing to load is a fault, and
     * collapsing them would let a corrupt weight look like an unsupported one.
     */
    load(path: string): Promise<LoadedWeight>
}

/**
 * Adapters — every runtime this daemon can execute weights with.
 *
 * A registry rather than a switch, and ordered: the first adapter to claim a
 * file gets it. Order is the tie-break policy, so a more specific runtime is
 * registered before a more general one and the rule stays readable as one
 * list rather than a precedence argument spread across `claims`
 * implementations.
 */
export function Adapters(adapters: readonly ModelAdapter[] = []) {
    return {
        /** Every runtime registered, in claim order. */
        get all(): readonly ModelAdapter[] {
            return adapters
        },

        /**
         * Which adapter runs this file, or null when none does.
         *
         * Null is a REAL answer: a weight this machine fetched and cannot
         * execute is coherent, and reporting an adapter we do not have would
         * move the failure from "refused to load" to "crashed while loading".
         */
        for(path: string): ModelAdapter | null {
            return adapters.find(adapter => adapter.claims(path)) ?? null
        },

        /**
         * Load a weight through whichever adapter claims it.
         *
         * Throws when nothing does, naming what was tried — "no runtime for
         * this file" is the one answer a caller can act on, and a silent null
         * would surface later as a model that is somehow never resident.
         */
        async load(path: string): Promise<{ runtime: ModelRuntime; weight: LoadedWeight }> {
            const adapter = this.for(path)
            if (!adapter) {
                throw err("MODEL_NO_RUNTIME", {
                    detail: `no runtime on this machine can execute ${path}`,
                    context: { path: path, runtimes: adapters.map(entry => entry.runtime) },
                })
            }
            return { runtime: adapter.runtime, weight: await adapter.load(path) }
        },
    }
}

export type AdaptersT = ReturnType<typeof Adapters>
