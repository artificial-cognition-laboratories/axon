import type { EngineCapability } from "@arcforge/types"

/**
 * A user's model choice, parsed.
 *
 * `"codex:gpt-5.6-terra"` names a route AND a model; `"gpt-5.6-terra"` names
 * only the model and lets ranking pick the route. Both forms exist because
 * they answer different questions: most models are reachable through two or
 * three routes at different prices, so a user usually cares WHICH MODEL and
 * only sometimes which route.
 */
export type ModelPin = {
    /** Route the pin names, when it named one. */
    provider?: string
    /** Model id, always present — a pin with no model is not a pin. */
    model: string
}

/**
 * Parse a `model:` string.
 *
 * Null for empty or whitespace-only input, which is the honest reading of "no
 * preference expressed" — a caller then ranks normally rather than matching
 * against an empty string and finding nothing.
 *
 * Splits on the FIRST colon only. Model ids contain slashes
 * (`anthropic/claude-sonnet-4-6`) and occasionally colons (`qwen3:8b` on
 * Ollama), so `"ollama:qwen3:8b"` has to mean route `ollama`, model `qwen3:8b`
 * — splitting on every colon would make every Ollama tag unpinnable.
 */
export function parsePin(value: string | undefined): ModelPin | null {
    const text = value?.trim()
    if (!text) return null

    const colon = text.indexOf(":")
    if (colon === -1) return { model: text }

    const provider = text.slice(0, colon).trim()
    const model = text.slice(colon + 1).trim()
    if (!provider || !model) return { model: text }

    return { provider, model }
}

/**
 * Does this capability satisfy the pin?
 *
 * Matched against the capability's OWN id and provider, both exactly. A
 * fuzzy match would be worse than none here: a user who typed a model name
 * expects that model, and silently running a similarly-named one is the
 * failure mode a pin exists to prevent.
 */
export function matchesPin(pin: ModelPin, capability: EngineCapability): boolean {
    if (pin.provider !== undefined && capability.provider !== pin.provider) return false
    return capability.id === pin.model
}
