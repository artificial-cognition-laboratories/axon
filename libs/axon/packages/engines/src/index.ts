/**
 * The provider factories are the public `Axon`/`Codex`/`Ollama`/`OpenRouter`
 * names now.
 *
 * They used to be ENGINE constructors — `Axon({ model })` returning an
 * AxonEngineDef for an agent's `engine:` field. That field is gone: a user
 * declares a POOL of providers and a cognet declares the roles it needs, so
 * "the one model this agent runs" is no longer a thing anyone writes down.
 * The drivers those constructors built are still here, reached through
 * `./drivers` — a provider constructs one once resolution has picked a model.
 */
export { Axon, Codex, OpenRouter, Ollama, HuggingFace, Mock, buildProvider, providerPool } from "./providers"
export type { ProviderOptions } from "./providers"

export { run, extractUserText } from "./mock"
export type { MockInput, MockHandler, MockReply, MockStep, MockRun, MockTurn, MockContext } from "./mock"

export { resolveEngines, primaryRole, reject, preference, parsePin, matchesPin } from "./resolver"
export type { ModelPin } from "./resolver"
export { EngineFailure, asEngineFault } from "./shared"
