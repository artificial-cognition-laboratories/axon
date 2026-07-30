import type { AxonEngineDef, AxonEngineDriver, AxonEngineRawEvent, AxonEngineRequest, EngineAutoWeights, EngineAutoLimits } from "@arcforge/types"

export type AxonOptions = {
    /** Catalog model ID e.g. "claude-sonnet-4-6", or "auto" to let Axon pick from a curated list — see `optimize`/`limit`. Omit to use the account default. */
    model?: string
    /** Only meaningful when model is "auto" — weights the pick by cost/intelligence/speed. Unset axes contribute 0; weights normalize to sum to 1. */
    optimize?: EngineAutoWeights
    /** Only meaningful when model is "auto" — hard ceilings applied before scoring (e.g. `{ cost: 1.25 }` = never pick a model over $1.25/M prompt tokens). */
    limit?: EngineAutoLimits
    /**
     * Engine deployment ID — connects directly to a specific engine by its
     * registry ID. e.g. "helios", "anthropic-harness"
     */
    id?: string
    /**
     * Direct WebSocket URL override. Bypasses registry resolution and
     * connects directly to this endpoint. For local dev or self-hosted
     * harnesses only.
     */
    url?: string
}

/**
 * Axon Cloud engine — managed inference, billed against the user's Axon
 * ledger. Any catalog model ID is valid, including models served via
 * OpenRouter upstream.
 *
 * Pure forwarder by design: routing, upstream provider choice, and billing
 * all live server-side behind cloud.engine.stream — the backend debits the
 * ledger atomically with the call and assembles the authoritative done
 * event (real token counts and cost). Swapping the upstream (raw routing
 * today, Helios later) never changes this engine.
 *
 * ```ts
 * import { Axon } from "@arcforge/engines"
 *
 * export default defineAgent({
 *     engine: Axon({ model: "claude-sonnet-4-6" }),
 *     // or let Axon pick from a curated, agent-capable model list:
 *     // engine: Axon({ model: "auto", optimize: { cost: 1 } }),
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/agent/engines/axon-cloud
 */
export function Axon(options: AxonOptions = {}): AxonEngineDef {
    return {
        name: "axon",
        ...(options.model !== undefined ? { model: options.model } : {}),

        create({ cloud }): AxonEngineDriver {
            return {
                async *stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
                    yield* cloud.cloud.engine.stream({
                        request: req,
                        ...(options.model !== undefined ? { model: options.model } : {}),
                        ...(options.optimize !== undefined ? { optimize: options.optimize } : {}),
                        ...(options.limit !== undefined ? { limit: options.limit } : {}),
                        ...(options.id !== undefined ? { id: options.id } : {}),
                        ...(options.url !== undefined ? { url: options.url } : {}),
                    })
                },
            }
        },
    }
}
