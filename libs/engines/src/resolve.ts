import type { AxonEngineDef, EngineConfig, EngineRef } from "@arcforge/types"
import { Axon } from "./axon"
import { Codex } from "./codex"
import { Ollama } from "./ollama"
import { OpenRouter } from "./openrouter"
import { Mock } from "./mock"

/**
 * resolveEngine — the one place a declarative EngineRef becomes a real
 * AxonEngineDef. Called by core's Engine manager at driver construction,
 * so every boot path (TUI, tests, deployed runtime) shares the seam.
 * Already-constructed defs pass through untouched.
 */
export function resolveEngine(config: EngineConfig): AxonEngineDef {
    if ("create" in config && typeof config.create === "function") return config

    const ref = config as EngineRef
    switch (ref.provider) {
        case "axon":
            return Axon({
                ...(ref.model !== undefined ? { model: ref.model } : {}),
                ...(ref.optimize !== undefined ? { optimize: ref.optimize } : {}),
                ...(ref.limit !== undefined ? { limit: ref.limit } : {}),
            })
        case "openrouter":
            return OpenRouter({ model: ref.model })
        case "codex":
            return Codex(ref.model !== undefined ? { model: ref.model } : {})
        case "ollama":
            return Ollama({ model: ref.model })
        case "mock":
            return Mock()
        default:
            throw new Error(
                `ENGINE_PROVIDER_UNKNOWN: ${JSON.stringify(ref)} — known providers: axon, openrouter, codex, ollama, mock`
            )
    }
}
