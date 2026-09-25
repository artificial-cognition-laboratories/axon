import type { ProviderEntry } from "@arcforge/types"

/**
 * ProviderGlobals — the declaration-only factories available while evaluating
 * an agent config. They deliberately do not import the engines runtime: a
 * provider declaration is data, while drivers and catalogues are boot work
 * for the runtime that actually uses one.
 */
export function ProviderGlobals() {
    type Options = { key?: string; url?: string; slots?: number }
    const entry = (provider: string, options: Options = {}): ProviderEntry => ({
        provider: provider,
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.url !== undefined ? { url: options.url } : {}),
        ...(options.slots !== undefined ? { slots: options.slots } : {}),
    })
    const provider = (name: string) => (options?: Options): ProviderEntry => entry(name, options)
    type MockEntry = ProviderEntry & { script?: unknown }
    const mock = (script?: unknown): MockEntry => {
        const isOptions = script !== undefined
            && script !== null
            && typeof script === "object"
            && Object.keys(script).length > 0
            && Object.keys(script).every(key => key === "key" || key === "url" || key === "slots")
        if (script === undefined || isOptions) return entry("mock", script as Options | undefined)
        return { ...entry("mock"), script: script }
    }

    const axon = provider("axon")
    const local = provider("local")
    const ollama = provider("ollama")
    const codex = provider("codex")
    const openRouter = provider("openrouter")
    const huggingFace = provider("huggingface")
    return {
        Axon: axon,
        Local: local,
        Ollama: ollama,
        Codex: codex,
        OpenRouter: openRouter,
        HuggingFace: huggingFace,
        Mock: mock,
    }
}

export type ProviderGlobalsT = ReturnType<typeof ProviderGlobals>
