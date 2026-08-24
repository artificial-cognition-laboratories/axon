import type { AxonEngineDef, EngineEffort, AxonEngineDriver, AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"
import { Collect } from "../shared"
import { OllamaBackend } from "./backend"

export type OllamaOptions = {
    /** Model name as listed in `ollama list` e.g. "qwen2.5:7b", "gemma4" */
    model: string
    /** Requested reasoning effort. Ollama models may ignore it. */
    effort?: EngineEffort
    /** Ollama host. Defaults to http://localhost:11434 */
    host?: string
}

/**
 * Ollama engine — routes inference to a locally running Ollama instance.
 * Requires Ollama to be running (`ollama serve`) with the model pulled
 * (`ollama pull <model>`). No credentials: the user's machine provides
 * inference, Cognos provides cognition.
 *
 * ```ts
 * import { Ollama } from "@arcforge/engines"
 *
 * export default defineAgent({
 *     providers: [Ollama()],
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/agent/engines/ollama
 */
export function Ollama(options: OllamaOptions): AxonEngineDef {
    const host = options.host ?? "http://localhost:11434"

    return {
        name: "ollama",
        model: options.model,
        ...(options.effort !== undefined ? { effort: options.effort } : {}),

        create(): AxonEngineDriver {
            const backend = OllamaBackend({ host, model: options.model })

            return {
                async *stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
                    const collect = Collect({ provider: "ollama", model: options.model })

                    for await (const delta of backend.stream(req)) {
                        const event = collect.feed(delta)
                        if (event) yield event
                    }

                    yield collect.done({ ...(req.signal ? { signal: req.signal } : {}) })
                },
            }
        },
    }
}
