import { existsSync, statSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { LoadedWeight, ModelAdapter } from "./adapter"

/**
 * The transformers.js adapter — a model REPOSITORY, not a weight.
 *
 * ── Why this exists beside the raw ONNX adapter ─────────────────────────────
 *
 * An ONNX graph has no notion of a prompt. It has typed input tensors with
 * fixed names, and turning "hello" into them is per-family work: a tokeniser
 * for a text model, a phonemiser and a style vector for Kokoro, a mel
 * spectrogram for Whisper. The raw adapter refuses text for exactly that
 * reason and reports the graph's real input names.
 *
 * transformers.js is that missing half, and it is not ours to write. Its
 * `pipeline()` reads the `tokenizer.json`, `preprocessor_config.json` and
 * `config.json` that ship INSIDE the repository, so support for a new
 * architecture arrives as a Hugging Face release rather than as per-model code
 * here. That is the whole reason to adopt it over hand-rolled processors: the
 * tail of model families is endless and it is somebody else's tail.
 *
 * ── Why it claims a directory ───────────────────────────────────────────────
 *
 * Every other adapter claims a file. This one claims the materialised tree the
 * store now builds for a set, because a tokeniser beside its weights is the
 * unit that can actually answer a question. `Adapters.for()` asks each adapter
 * in order and a directory is simply a path the file-based ones decline, so no
 * routing logic had to learn about the distinction.
 *
 * ── Why the import is lazy ──────────────────────────────────────────────────
 *
 * Same posture as the other two: an optional dependency reports its absence
 * honestly rather than crashing at import, so a CLI installed by someone who
 * never runs a local model does not carry it.
 */
export function TransformersAdapter(): ModelAdapter {
    let runtime: Promise<TransformersModule | null> | null = null

    function load(): Promise<TransformersModule | null> {
        // Built rather than literal so the compiler does not resolve it: the
        // package is OPTIONAL, and a static import would make the build
        // require exactly what this adapter exists to work without.
        const specifier = "@huggingface" + "/transformers"
        runtime ??= import(specifier)
            .then(module => module as unknown as TransformersModule)
            .catch(() => null)
        return runtime
    }

    return {
        runtime: "transformers",

        /**
         * A DIRECTORY holding a config, which is what a pipeline can open.
         *
         * `config.json` rather than the presence of a weight: a directory of
         * `.onnx` files with no config is exactly the case the raw adapter
         * serves, and claiming it here would replace a working tensor call
         * with a pipeline that cannot construct itself.
         */
        claims(path: string): boolean {
            try {
                if (!statSync(path).isDirectory()) return false
            } catch {
                // Unreadable is NOT claimed, for the reason the ONNX adapter
                // gives: a permissions problem must not become a load failure
                // attributed to the wrong runtime.
                return false
            }
            return existsSync(join(path, "config.json"))
        },

        async load(path: string): Promise<LoadedWeight> {
            const module = await load()
            if (!module) {
                throw err("MODEL_RUNTIME_MISSING", {
                    detail: "@huggingface/transformers is not installed — add it to run model repositories locally",
                    context: { runtime: "transformers", path: path },
                })
            }
            const transformers: TransformersModule = module

            /*
             * Local only, and told so explicitly.
             *
             * transformers.js reaches for the Hugging Face hub by default when
             * a file is missing. The daemon has already downloaded and VERIFIED
             * every file this needs; letting the library fetch a replacement
             * would put unverified bytes beside verified ones and make the
             * store's content-addressing a claim rather than a fact. A missing
             * file must fail loudly here.
             */
            transformers.env.allowRemoteModels = false
            transformers.env.allowLocalModels = true

            const task = taskFor(path)

            let pipe: Pipeline
            try {
                pipe = await transformers.pipeline(task, path, { local_files_only: true })
            } catch (cause) {
                // Claimed and unloadable is a FAULT, distinct from not
                // claiming: a repository missing its tokeniser must not look
                // like an unsupported format.
                throw err("MODEL_LOAD_FAILED", {
                    detail: `${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { runtime: "transformers", path: path, task: task },
                    cause,
                })
            }

            const generative = task === "text-generation"

            /**
             * One call through the pipeline.
             *
             * A named closure for the reason every verb in this package is
             * one: the handle is invoked DETACHED, so a sibling reached
             * through `this` is undefined.
             */
            async function call(input: unknown, opts?: Record<string, unknown>): Promise<unknown> {
                const payload = task === "automatic-speech-recognition" && typeof input === "string"
                    ? await samples(input)
                    : input
                try {
                    return plain(await pipe(payload as never, opts as never))
                } catch (cause) {
                    /*
                     * Wrapped, because a third-party error has no code.
                     *
                     * The daemon's socket carries an AxonError's code so a
                     * caller sees what a local caller would; anything else
                     * arrives as the generic "not wired" fallback. A library
                     * throwing a plain Error therefore reads to a user as a
                     * daemon that has not been built, which is a lie about
                     * both the daemon and the failure.
                     */
                    throw err("MODEL_RUN_FAILED", {
                        detail: `${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
                        context: { runtime: "transformers", path: path, task: task },
                        cause,
                    })
                }
            }

            return {
                /**
                 * The task's own bytes are not reported by the library, so the
                 * directory is measured. An approximation, and an honest one:
                 * the weights dominate, and over-reporting slightly is the safe
                 * direction for an admission check.
                 */
                bytes: sizeOf(path),

                engine: generative ? "generate" : "transform",

                ...(generative
                    ? {
                        async generate(request: { prompt: string; maxTokens?: number; temperature?: number }): Promise<string> {
                            const out = await call(request.prompt, {
                                ...(request.maxTokens !== undefined ? { max_new_tokens: request.maxTokens } : {}),
                                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                            })
                            return text(out)
                        },
                    }
                    : { transform: call }),

                run: call,

                async unload(): Promise<void> {
                    // Best effort: an already-disposed pipeline throwing must
                    // not make unloading twice an error.
                    try { await pipe.dispose?.() } catch { /* already gone */ }
                },
            }
        },
    }
}

/**
 * A library object, as data a caller can actually read.
 *
 * transformers.js returns its own `Tensor` for embeddings, which carries a
 * typed array behind several layers of runtime bookkeeping. Handed straight to
 * `JSON.stringify` — which is exactly what happens when it crosses the daemon's
 * socket — that became `{"ort_tensor":{"cpuData":{"0":5.42,"1":-0.08,…}}}`: an
 * index-keyed object of nine hundred entries, technically the vector and
 * useless as one.
 *
 * So a tensor becomes `{ dims, data }` with a real array. Anything else is
 * passed through untouched: the contract is that this package does not
 * interpret what a model's output MEANS, and turning a shape into readable
 * data is not interpreting it.
 */
function plain(out: unknown): unknown {
    const tensor = out as { dims?: unknown; data?: unknown; ort_tensor?: { dims?: unknown; cpuData?: unknown } }
    const dims = tensor?.dims ?? tensor?.ort_tensor?.dims
    const data = tensor?.data ?? tensor?.ort_tensor?.cpuData
    if (Array.isArray(dims) && ArrayBuffer.isView(data)) {
        return { dims: dims, data: Array.from(data as unknown as ArrayLike<number>) }
    }
    return out
}

/**
 * Decode an audio file to the samples a speech pipeline wants.
 *
 * ── Why the adapter does this ───────────────────────────────────────────────
 *
 * transformers.js cannot read audio in Node: it decodes through `AudioContext`,
 * which only exists in a browser, and its own guidance is that samples should
 * be passed in already decoded. Left alone, `axon daemon run <whisper> -p
 * recording.wav` fails with a message about a Web API — true, and useless to
 * someone holding a file.
 *
 * A path is the only thing a keybind, a CLI or a socket CAN pass, so decoding
 * belongs on this side of the boundary. Doing it here rather than in the daemon
 * keeps it where the requirement is: this is a fact about how speech pipelines
 * are called, not about how models are managed.
 *
 * ── Why ffmpeg ──────────────────────────────────────────────────────────────
 *
 * Whisper wants 16kHz mono float32, and a recording is whatever the microphone
 * or the download happened to be — 44.1kHz stereo in the common case. Parsing
 * WAV by hand would cover one container and silently mishandle the rest;
 * ffmpeg resamples, downmixes and decodes every format, and it is already on
 * any machine that plays media. Its absence is reported as the missing tool it
 * is rather than as a model failure.
 */
async function samples(path: string): Promise<Float32Array> {
    if (!existsSync(path)) {
        throw err("MODEL_INPUT_INVALID", {
            detail: `${path} is not a file — a speech model takes a path to audio`,
            context: { runtime: "transformers", path: path },
        })
    }

    const decoded = Bun.spawn({
        // f32le mono at 16k: the pipeline's expected shape, produced by the
        // decoder rather than corrected afterwards.
        cmd: ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        stdout: "pipe",
        stderr: "pipe",
    })

    const [raw, problem, code] = await Promise.all([
        new Response(decoded.stdout).arrayBuffer(),
        new Response(decoded.stderr).text(),
        decoded.exited,
    ]).catch(() => [null, "", -1] as const)

    if (code !== 0 || !raw) {
        throw err("MODEL_INPUT_INVALID", {
            detail: raw === null
                ? "ffmpeg is not installed — decoding audio for a speech model needs it"
                : `${path} could not be decoded — ${problem.trim().split("\n").pop() ?? "ffmpeg failed"}`,
            context: { runtime: "transformers", path: path },
        })
    }

    return new Float32Array(raw)
}

/**
 * Which pipeline a repository wants, from what it declares about itself.
 *
 * `config.json` carries the architecture, and transformers.js keys everything
 * off the same file — so this reads the repository's own claim rather than
 * guessing from a name. Falling back to feature extraction is deliberate: it
 * is the task that works for any encoder, so an architecture this does not
 * recognise degrades to embeddings instead of failing to load at all.
 */
function taskFor(path: string): PipelineTask {
    const config = read(join(path, "config.json"))
    const architectures = Array.isArray(config?.architectures) ? config.architectures.map(String) : []
    const kind = String(config?.model_type ?? "").toLowerCase()
    const arch = architectures.join(" ").toLowerCase()

    if (kind.includes("whisper") || arch.includes("whisper")) return "automatic-speech-recognition"
    if (arch.includes("forcausallm") || arch.includes("forconditionalgeneration")) return "text-generation"
    if (existsSync(join(path, "preprocessor_config.json")) && arch.includes("imageclassification")) {
        return "image-classification"
    }

    /*
     * Speech SYNTHESIS is refused, not degraded.
     *
     * The fallback below is a real degradation for an unrecognised ENCODER:
     * feature extraction is what any encoder can do, so an architecture this
     * does not know still produces embeddings rather than failing to load.
     *
     * That reasoning does not reach a text-to-speech model. Kokoro declares
     * `style_text_to_speech_2`, transformers.js has no pipeline for it, and
     * running it as an encoder would load cleanly and return vectors that mean
     * nothing — a wrong answer wearing the shape of a right one, which is the
     * one failure worth refusing outright. Kokoro needs `kokoro-js`, which
     * carries the phonemiser transformers.js does not ship.
     */
    if (kind.includes("text_to_speech") || kind.includes("vits") || kind.includes("bark")) {
        throw err("MODEL_NO_RUNTIME", {
            detail: `${path} is a speech-synthesis model (${kind}) — `
                + `no runtime on this machine can execute one yet`,
            context: { runtime: "transformers", modelType: kind },
        })
    }

    return "feature-extraction"
}

function read(path: string): Record<string, unknown> | null {
    try {
        return JSON.parse(require("node:fs").readFileSync(path, "utf-8")) as Record<string, unknown>
    } catch {
        return null
    }
}

/** Total bytes under a directory, one level of recursion at a time. */
function sizeOf(path: string): number {
    let total = 0
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        total += entry.isDirectory() ? sizeOf(child) : statSync(child).size
    }
    return total
}

/**
 * The text out of whatever shape a pipeline returned.
 *
 * Generation returns `[{ generated_text }]`, transcription returns `{ text }`,
 * and neither is worth a caller's knowledge. Anything else is handed back as
 * JSON rather than coerced to "[object Object]".
 */
function text(out: unknown): string {
    if (typeof out === "string") return out
    const first = Array.isArray(out) ? out[0] : out
    const record = first as { generated_text?: unknown; text?: unknown } | null
    if (record && typeof record.generated_text === "string") return record.generated_text
    if (record && typeof record.text === "string") return record.text
    return JSON.stringify(out)
}

type PipelineTask =
    | "text-generation"
    | "automatic-speech-recognition"
    | "feature-extraction"
    | "image-classification"

type Pipeline = ((input: never, opts?: never) => Promise<unknown>) & { dispose?(): Promise<void> }

/**
 * The slice of `@huggingface/transformers` this uses.
 *
 * Declared locally rather than imported as a type, because the package is
 * OPTIONAL — a type import would make the build require what the runtime
 * deliberately does not.
 */
type TransformersModule = {
    pipeline(task: string, model: string, opts?: Record<string, unknown>): Promise<Pipeline>
    env: { allowRemoteModels: boolean; allowLocalModels: boolean }
}
