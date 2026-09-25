import { err } from "@arcforge/err"
import type { ModelRef } from "@arcforge/types"

/**
 * A model specifier, parsed.
 *
 * `hf:owner/repo/path/to/file.onnx` is the short form and covers almost
 * everything. Parsing is total and eager: a malformed specifier throws HERE,
 * at prepare, naming the cognet field — never at fetch time with a confusing
 * 404, and never at first inference with a missing file.
 */
export type ParsedModel = {
    /** The local name the cognet addresses this weight by. */
    key: string
    host: "hf"
    /** `owner/repo` */
    repo: string
    /** Path within the repo. A repo is a directory; big ones hold many weights. */
    file: string
    /** Complete repository layout rather than one file. */
    set?: boolean
    /** Git revision. `main` unless pinned. */
    rev: string
    /** Expected content hash, when the author pinned one. */
    sha256?: string
    /** Optional provider capability metadata carried into the machine cache. */
    traits?: {
        capability?: string
        type?: "generate" | "transform" | "stream"
        in?: string[]
        out?: string[]
    }
}

/** The one place a model's fetch URL is constructed. */
export function downloadUrl(model: ParsedModel): string {
    return `https://huggingface.co/${model.repo}/resolve/${model.rev}/${model.file}`
}

/** The filename a cached model is stored under — the last path segment. */
export function basenameOf(model: ParsedModel): string {
    return model.file.split("/").pop()!
}

/**
 * Parse one declared model.
 *
 * The string form splits on the FIRST TWO path segments being the repo and
 * everything after being the file, because HF repos nest arbitrarily:
 * `hf:ggerganov/whisper.cpp/ggml-base.en.bin` is repo `ggerganov/whisper.cpp`
 * and file `ggml-base.en.bin`, while
 * `hf:onnx-community/silero-vad/onnx/model.onnx` keeps `onnx/model.onnx`
 * whole.
 */
export function parseModel(key: string, ref: ModelRef): ParsedModel {
    if (typeof ref !== "string") {
        if (!ref.hf || (!ref.file && !ref.set)) {
            throw err("MODEL_SPECIFIER_INVALID", {
                detail: `models.${key}: the object form needs both "hf" (owner/repo) and "file"`,
                context: { key },
            })
        }
        return {
            key,
            host: "hf",
            repo: ref.hf,
            file: ref.file ?? "",
            ...(ref.set ? { set: true } : {}),
            rev: ref.rev ?? "main",
            ...(ref.sha256 ? { sha256: ref.sha256 } : {}),
            ...((ref.capability || ref.type || ref.in || ref.out) ? {
                traits: {
                    ...(ref.capability ? { capability: ref.capability } : {}),
                    ...(ref.type ? { type: ref.type } : {}),
                    ...(ref.in ? { in: ref.in } : {}),
                    ...(ref.out ? { out: ref.out } : {}),
                },
            } : {}),
        }
    }

    const colon = ref.indexOf(":")
    if (colon === -1) {
        throw err("MODEL_SPECIFIER_INVALID", {
            detail: `models.${key}: "${ref}" has no scheme — expected "hf:owner/repo/file"`,
            context: { key, specifier: ref },
        })
    }

    const scheme = ref.slice(0, colon)
    if (scheme !== "hf") {
        throw err("MODEL_SPECIFIER_INVALID", {
            detail: `models.${key}: unknown scheme "${scheme}" — only "hf:" is supported today`,
            context: { key, specifier: ref, scheme },
        })
    }

    const segments = ref.slice(colon + 1).split("/").filter(Boolean)
    if (segments.length < 3) {
        // Two segments is a bare repo, which is ambiguous: a repo is a
        // directory, and `ggerganov/whisper.cpp` alone names twenty
        // quantisations of the same model. The file is not optional.
        throw err("MODEL_SPECIFIER_INVALID", {
            detail:
                `models.${key}: "${ref}" names a repo but no file — a repo holds many weights, `
                + `so say which (e.g. "hf:owner/repo/model.onnx")`,
            context: { key, specifier: ref },
        })
    }

    return {
        key,
        host: "hf",
        repo: `${segments[0]}/${segments[1]}`,
        file: segments.slice(2).join("/"),
        rev: "main",
    }
}

/** Parse a whole `models:` declaration. Throws on the first malformed entry. */
export function parseModels(models: Record<string, ModelRef> | undefined): ParsedModel[] {
    if (!models) return []
    return Object.entries(models).map(([key, ref]) => parseModel(key, ref))
}
