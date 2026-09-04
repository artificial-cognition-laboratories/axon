import { openSync, readSync, closeSync, statSync } from "node:fs"
import { err } from "@arcforge/err"
import type { LoadedWeight, ModelAdapter } from "./adapter"

/**
 * The llama.cpp adapter — GGUF generation.
 *
 * ── Why this is the second adapter ──────────────────────────────────────────
 *
 * ONNX landed first because it covered the whole `transform` and `stream`
 * half — speech, embeddings, vision — that nothing else on the machine did,
 * and generation was left to Ollama and LM Studio, which are already
 * providers. That reasoning held exactly as long as generation was somebody
 * else's product. It stops holding the moment the daemon is asked to BE the
 * local runtime: a model browser that can fetch a GGUF and then not run it is
 * a downloader.
 *
 * ── Why the import is lazy ──────────────────────────────────────────────────
 *
 * `node-llama-cpp` ships prebuilt native binaries per platform, and most
 * people who install the CLI will never load a local weight. Optional and
 * imported at first use, exactly as `onnxruntime-node` is, so its absence is
 * an honest answer rather than a crash at import time.
 *
 * ── Why claiming reads the file ─────────────────────────────────────────────
 *
 * `.gguf` is conventional and not required — quantisations ship as `.bin`, and
 * `.bin` is also a PyTorch checkpoint and a whisper.cpp weight. The adapter
 * contract says a format whose extension is ambiguous needs a header read "in
 * the adapter that has to disambiguate it", so this reads the four magic bytes
 * rather than trusting a suffix. Four bytes is cheap enough to pay per
 * candidate while routing.
 */
export function LlamaAdapter(): ModelAdapter {
    /**
     * The loaded module, or null when it is not installed.
     *
     * Resolved once and remembered, including the failure: an optional
     * dependency does not appear mid-session, and retrying the import per
     * `claims()` would pay a resolution failure on every row of a model list.
     */
    let runtime: Promise<LlamaModule | null> | null = null

    function load(): Promise<LlamaModule | null> {
        // Built rather than literal so the compiler does not resolve it: the
        // package is OPTIONAL, and a static import would make the build require
        // exactly what this adapter exists to work without.
        const specifier = "node-" + "llama-cpp"
        runtime ??= import(specifier)
            .then(module => module as unknown as LlamaModule)
            .catch(() => null)
        return runtime
    }

    return {
        runtime: "llama.cpp",

        claims(path: string): boolean {
            return isGguf(path)
        },

        async load(path: string): Promise<LoadedWeight> {
            const module = await load()
            if (!module) {
                throw err("MODEL_RUNTIME_MISSING", {
                    detail: "node-llama-cpp is not installed — add it to run GGUF weights locally",
                    context: { runtime: "llama.cpp", path: path },
                })
            }
            /*
             * Re-bound after the guard, deliberately.
             *
             * TypeScript narrows `module` here but cannot carry that narrowing
             * into the function declared below — a closure may run after
             * anything, so the compiler will not assume the check still holds.
             * A non-null binding makes it a property of the name rather than of
             * the control flow, which is true and needs no assertion.
             */
            const llamaCpp: LlamaModule = module

            let model: LlamaModel
            let context: LlamaContext
            try {
                const llama = await llamaCpp.getLlama()
                model = await llama.loadModel({ modelPath: path })
                context = await model.createContext()
            } catch (cause) {
                // Claimed and unreadable is a FAULT, distinct from not
                // claiming: a corrupt or truncated weight must not look like an
                // unsupported format.
                throw err("MODEL_LOAD_FAILED", {
                    detail: `${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { runtime: "llama.cpp", path: path },
                    cause,
                })
            }

            /**
             * One completion.
             *
             * A named closure, not a method, because the handle is invoked
             * DETACHED: `run` delegates here, and reaching a sibling through
             * `this` is undefined the moment anything holds the verb rather
             * than the object.
             */
            async function generate(request: { prompt: string; maxTokens?: number; temperature?: number }): Promise<string> {


                    // A session per call, sharing one context. Conversation
                    // state belongs to whoever is having the conversation —
                    // the daemon holds a WEIGHT, not a chat, and a session
                    // kept here would leak one caller's history into the next.
                    /*
                     * The SEQUENCE is the scarce thing, not the session.
                     *
                     * A context is created with a fixed number of sequence
                     * slots. Disposing the session alone left every slot it
                     * took still allocated, so the fourth or fifth call threw
                     * "No sequences left" — a leak that looks like a model
                     * fault and only ever appears after the thing has already
                     * been demonstrated to work.
                     *
                     * Held in a variable so the release is unconditional:
                     * `getSequence()` inline had nothing left to dispose once
                     * the session owned it.
                     */
                    const sequence = context.getSequence()
                    const session = new llamaCpp.LlamaChatSession({ contextSequence: sequence })
                    try {
                        return await session.prompt(request.prompt, {
                            ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
                            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                        })
                    } finally {
                        session.dispose?.()
                        // Best effort, and after the session: a sequence
                        // released while its session still holds it is a
                        // use-after-free in native code.
                        try { sequence.dispose?.() } catch { /* already gone */ }
                    }
            }

            return {
                engine: "generate" as const,

                /**
                 * What the runtime reports, falling back to the file.
                 *
                 * A GGUF's resident cost is close to its file size and the
                 * binding usually reports it; where it does not, the file is
                 * the honest approximation and errs slightly high — which is
                 * the safe direction for an admission check.
                 */
                bytes: typeof model.size === "number" && model.size > 0 ? model.size : statSync(path).size,

                /**
                 * One completion.
                 *
                 * `unknown` in and out, per the contract: a string prompt is
                 * the ergonomic form, and an object carries the options a
                 * caller wants to vary. Anything else is refused rather than
                 * coerced — a prompt silently read as "[object Object]" is a
                 * bill for tokens and a nonsense answer.
                 */
                /**
                 * The typed verb. `run` below is the same call with a looser
                 * door on it, so there is one implementation rather than two
                 * that can drift.
                 */
                generate: generate,

                /**
                 * One completion, for a caller that has not narrowed its input.
                 *
                 * A string prompt is the ergonomic form and an object carries
                 * the options; anything else is refused rather than coerced —
                 * a prompt silently read as "[object Object]" is a bill for
                 * tokens and a nonsense answer.
                 */
                async run(input: unknown): Promise<unknown> {
                    const request = typeof input === "string" ? { prompt: input } : input as GenerateInput
                    if (!request || typeof request.prompt !== "string") {
                        throw err("MODEL_INPUT_INVALID", {
                            detail: "llama.cpp takes a prompt string, or an object carrying one",
                            context: { runtime: "llama.cpp" },
                        })
                    }
                    return await generate(request as { prompt: string; maxTokens?: number; temperature?: number })
                },

                async unload(): Promise<void> {
                    // Best-effort and in order — context before model, because
                    // a context outliving its model is a use-after-free in
                    // native code rather than a tidy error.
                    try { await context.dispose?.() } catch { /* already gone */ }
                    try { await model.dispose?.() } catch { /* already gone */ }
                },
            }
        },
    }
}

/** GGUF's four magic bytes, which every file of the format opens with. */
const MAGIC = "GGUF"

function isGguf(path: string): boolean {
    let fd: number | undefined
    try {
        fd = openSync(path, "r")
        const head = Buffer.alloc(4)
        const read = readSync(fd, head, 0, 4, 0)
        return read === 4 && head.toString("ascii") === MAGIC
    } catch {
        // Unreadable is NOT claimed. An adapter that claimed a file it could
        // not open would turn a permissions problem into a load failure
        // attributed to the wrong runtime.
        return false
    } finally {
        if (fd !== undefined) {
            try { closeSync(fd) } catch { /* already closed */ }
        }
    }
}

type GenerateInput = { prompt?: unknown; maxTokens?: number; temperature?: number }

/**
 * The slice of `node-llama-cpp` this uses.
 *
 * Declared locally rather than imported as a type, because the package is
 * OPTIONAL — a type import would make the build require what the runtime
 * deliberately does not.
 */
type LlamaModule = {
    getLlama(): Promise<{ loadModel(opts: { modelPath: string }): Promise<LlamaModel> }>
    LlamaChatSession: new (opts: { contextSequence: unknown }) => LlamaSession
}

type LlamaModel = {
    size?: number
    createContext(): Promise<LlamaContext>
    dispose?(): Promise<void>
}

type LlamaContext = {
    getSequence(): LlamaSequence
    dispose?(): Promise<void>
}

/** One slot in a context. Finite, and returned to the pool by `dispose`. */
type LlamaSequence = {
    dispose?(): void
}

type LlamaSession = {
    prompt(text: string, opts?: Record<string, unknown>): Promise<string>
    dispose?(): void
}
