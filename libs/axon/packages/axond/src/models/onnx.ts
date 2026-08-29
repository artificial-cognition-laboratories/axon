import { statSync } from "node:fs"
import { err } from "@arcforge/err"
import type { LoadedWeight, ModelAdapter } from "./adapter"

/**
 * The ONNX runtime adapter.
 *
 * ── Why the import is lazy ──────────────────────────────────────────────────
 *
 * `onnxruntime-node` is ~300MB of platform-specific native binaries. As a hard
 * dependency it ships in the published CLI, so every `axon` install pays it —
 * including the majority who never run a local model. As an OPTIONAL one it is
 * absent until someone wants local inference, and this adapter reports that
 * absence honestly rather than crashing at the import.
 *
 * That is the same posture the daemon takes everywhere else: `machine.vram` is
 * null when unmeasurable, `Boot` reports `supported: false` rather than writing
 * a unit that cannot work, and an unwired domain throws. "This machine has no
 * ONNX runtime" is a real answer, and MODEL_NO_RUNTIME exists to give it.
 *
 * ── Why ONNX first ──────────────────────────────────────────────────────────
 *
 * It covers the whole `transform` and `stream` half — speech recognition,
 * voice activity detection, embeddings, vision — with one dependency and no
 * plugin host. Generation stays with Ollama and LM Studio, which are already
 * providers, so the adapter that lands first is the one nothing else covers.
 */
export function OnnxAdapter(): ModelAdapter {
    /**
     * The loaded module, or null when it is not installed.
     *
     * Resolved ONCE and remembered, including the failure: a missing optional
     * dependency does not appear halfway through a session, and retrying the
     * import per `claims()` would pay a resolution failure on every row of a
     * model list.
     */
    let runtime: Promise<OnnxModule | null> | null = null

    function load(): Promise<OnnxModule | null> {
        // The specifier is built rather than literal so the compiler does not
        // resolve it: the package is OPTIONAL, and a static import would make
        // the build require exactly what this adapter exists to work without.
        // Bun and Node both resolve it at runtime when it is installed.
        const specifier = "onnxruntime" + "-node"
        runtime ??= import(specifier)
            .then(module => module as unknown as OnnxModule)
            .catch(() => null)
        return runtime
    }

    return {
        runtime: "onnx",

        /**
         * By EXTENSION, deliberately — not by reading the file.
         *
         * `claims` runs per candidate while routing and must stay cheap. ONNX
         * is the one format here whose extension is unambiguous: a `.onnx`
         * file is a protobuf graph and nothing else uses the suffix. A format
         * whose extension IS ambiguous (`.bin` is GGUF, a PyTorch checkpoint,
         * and a whisper.cpp weight) needs a header read, and that belongs in
         * the adapter that has to disambiguate it rather than here.
         */
        claims(path: string): boolean {
            return path.toLowerCase().endsWith(".onnx")
        },

        async load(path: string): Promise<LoadedWeight> {
            const onnx = await load()
            if (!onnx) {
                throw err("MODEL_RUNTIME_MISSING", {
                    detail: "onnxruntime-node is not installed — run `axon models runtime onnx` to add it",
                    context: { runtime: "onnx", path: path },
                })
            }

            let session: OnnxSession
            try {
                session = await onnx.InferenceSession.create(path)
            } catch (cause) {
                // Claimed and unreadable is a FAULT, distinct from not
                // claiming: a corrupt weight must not look like an
                // unsupported format.
                throw err("MODEL_LOAD_FAILED", {
                    detail: `${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { runtime: "onnx", path: path },
                    cause,
                })
            }

            return {
                /**
                 * The file's size, as the cost.
                 *
                 * An approximation, and an honest one: ONNX Runtime does not
                 * report a session's resident footprint, and the weights
                 * dominate it. Over-reporting slightly is the safe direction
                 * for an admission check — it refuses a load that would have
                 * just fit rather than accepting one that then OOMs.
                 */
                bytes: statSync(path).size,

                async run(input: unknown): Promise<unknown> {
                    return session.run(input as Record<string, unknown>)
                },

                async unload(): Promise<void> {
                    // Release is best-effort: an already-released session
                    // throwing must not make unloading twice an error.
                    await session.release?.().catch(() => {})
                },
            }
        },
    }
}

/**
 * The slice of `onnxruntime-node` this uses.
 *
 * Declared locally rather than imported as a type, because the package is
 * OPTIONAL — a type import would make the build require what the runtime
 * deliberately does not.
 */
type OnnxModule = {
    InferenceSession: { create(path: string): Promise<OnnxSession> }
}

type OnnxSession = {
    run(feeds: Record<string, unknown>): Promise<unknown>
    release?(): Promise<void>
}
