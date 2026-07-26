import type { AxonEngineDef, AxonEngineDriver, AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"
import { Collect } from "../shared"
import { CodexBackend } from "./backend"

type CodexCurrentModel =
    | "gpt-5.5"
    | "gpt-5.6-luna"
    | "gpt-5.4-mini"
    | "gpt-5.6-terra"

export type CodexOptions = {
    /** Codex model to use. Defaults to "gpt-5.5". */
    model?: CodexCurrentModel | (string & {})
    /** Reasoning effort level. Only valid for models that support reasoning. Defaults to "medium". */
    effort?: "low" | "medium" | "high" | "xhigh"
}

/**
 * Codex engine — routes inference through the user's ChatGPT Plus/Pro
 * Codex subscription (BYOK OAuth, no API key). Credentials are the
 * runtime's job: the backend leaf mints a narrow vault token through the
 * cloud client per request (cached until expiry client-side, refreshed
 * server-side) so rotation never rebuilds the driver. Connect once with
 * `:provider openai connect` (or the dashboard) and every agent on the
 * account can use Codex — locally or deployed. An unconnected account
 * fails loudly on first use with the backend's VAULT_NOT_CONNECTED.
 *
 * ```ts
 * import { Codex } from "@arcforge/engines"
 *
 * export default defineAgent({
 *     engine: Codex({ model: "gpt-5.5", effort: "medium" }),
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/agent/engines/codex
 */
export function Codex(options: CodexOptions = {}): AxonEngineDef {
    const model = options.model ?? "gpt-5.5"
    const effort = options.effort ?? "medium"

    return {
        name: "codex",
        model,

        create({ cloud }): AxonEngineDriver {
            const backend = CodexBackend({ cloud, model, effort })

            return {
                async *stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
                    const collect = Collect({ provider: "codex", model })

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
