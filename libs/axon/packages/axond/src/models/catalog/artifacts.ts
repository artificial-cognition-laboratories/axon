import { onnx } from "@arcforge/platform/build/project"
import { RUNNABLE, SHARD } from "./formats"

/** Plan one supported artifact or one coherent ONNX set. */
export function Artifacts() {
    // One coherent ONNX set, and the dtype to load it as, are the model
    // toolchain's (see @arcforge/platform onnx) — one copy, so what is
    // downloaded and what is loaded cannot disagree.
    return { preferred: preferred, plan: onnx.plan, dtype: onnx.dtype, chat: chat, gguf: gguf }

function gguf(name: string): boolean {
    return /\.gguf$/i.test(name) && !SHARD.test(name) && !/(^|\/)mmproj[-_.]/i.test(name)
}
function chat(names: string[], sizes: Record<string, number> = {}) {
    const weights = names.filter(gguf)
    const file = weights.find(name => /Q4_K_M\.gguf$/i.test(name))
        ?? weights.find(name => /Q4_K_S\.gguf$/i.test(name))
        ?? weights.sort((a, b) => (sizes[a] ?? Infinity) - (sizes[b] ?? Infinity))[0]
    if (file) return { runtime: "llama.cpp" as const, file: file, files: [file], bytes: sizes[file] ?? null }
    const set = names.includes("config.json") ? onnx.plan(names) : null
    if (!set) return null
    const bytes = set.files.every(name => sizes[name] !== undefined) ? set.files.reduce((sum, name) => sum + sizes[name]!, 0) : null
    return { runtime: "transformers" as const, file: undefined, files: set.files, bytes: bytes }
}

function preferred(names: string[]): string | null {
    const nominated = names.find(name => name === "onnx/model.onnx" || name === "model.onnx")
    if (nominated) return nominated

    const runnable = names.filter(name => RUNNABLE.some(ext => name.toLowerCase().endsWith(ext)) && !/(^|\/)mmproj[-_.]/i.test(name))
    if (runnable.length === 0) return null

    const atRoot = runnable.filter(name => !name.includes("/"))
    if (atRoot.length === 1) return atRoot[0]!
    if (atRoot.length > 1) return single(atRoot)

    return single(runnable)
}

function single(names: string[]): string | null {
    if (names.length === 1) return names[0]!

    const whole = names.filter(name => !SHARD.test(name))
    return whole.length === 1 ? whole[0]! : null
}
}
