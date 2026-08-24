/**
 * The transport constructors, by provider.
 *
 * Formerly the public `Axon()`/`Codex()`/... — an agent named one in its
 * `engine:` field and got a driver bound to one model. That decision moved:
 * a provider now answers what it can supply, and a driver is built AFTER
 * resolution has chosen. So these are internal construction, not an
 * authoring surface, and they carry the old names only inside this module.
 */
export { Axon as AxonDriver } from "./axon"
export type { AxonOptions } from "./axon"
export { Codex as CodexDriver } from "./codex"
export type { CodexOptions } from "./codex"
export { Ollama as OllamaDriver } from "./ollama"
export type { OllamaOptions } from "./ollama"
export { OpenRouter as OpenRouterDriver } from "./openrouter"
export type { OpenRouterOptions } from "./openrouter"
export { Mock as MockDriver } from "./mock"
