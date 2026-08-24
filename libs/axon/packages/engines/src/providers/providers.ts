import type { EngineCloud, ProviderEntry } from "@arcforge/types"
import { HostedProvider, OllamaProvider, type AxonProvider } from "../catalogue"
import { EngineFailure } from "../shared"
import { AxonDriver, CodexDriver, OllamaDriver, OpenRouterDriver, MockDriver } from "../drivers"
import type { MockHandler, MockReply } from "../mock"

/**
 * Provider factories — what a user writes in `providers: [...]`.
 *
 * Each returns a DECLARATION, not a connection: calling one does no network
 * and no filesystem work, so a profile listing four providers costs nothing
 * to load and a user with no network still gets a terminal. Reachability is
 * discovered when a catalogue is asked, which is a point where someone is
 * waiting for an answer and a failure can be shown.
 *
 * These names used to mean something else. `Axon({ model })` was an ENGINE
 * constructor — one model, bound into `engine:` at config-write time — and
 * for a while both existed, which put two different meanings on one
 * identifier in one global namespace. A profile writing `providers: [Axon()]`
 * silently got the engine constructor's `{ name: "axon" }` where a
 * `{ provider: "axon" }` was required, and nothing caught it because both are
 * objects. `engine:` is gone and so is that ambiguity: there is one `Axon()`
 * and it declares a source of inference.
 */

export type ProviderOptions = {
    /** Own credential, for a user supplying one rather than connecting their account. */
    key?: string
    /** Endpoint override — self-hosted daemons, local harnesses. */
    url?: string
    /** Ceiling on concurrent calls a fanned-out role may spend here. */
    slots?: number
}

function entry(name: string, options: ProviderOptions = {}): ProviderEntry {
    return {
        provider: name,
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.url !== undefined ? { url: options.url } : {}),
        ...(options.slots !== undefined ? { slots: options.slots } : {}),
    }
}

/**
 * Managed inference, billed to the user's Axon ledger.
 *
 * The default, and the only one needing no setup beyond being signed in. It
 * supplies the full curated catalogue, so on this provider alone every
 * generate role a cognet can declare resolves — which is why an ordinary
 * user never meets any of this machinery.
 */
export function Axon(options?: ProviderOptions): ProviderEntry {
    return entry("axon", options)
}

/** The user's ChatGPT subscription, through a connected OpenAI account. */
export function Codex(options?: ProviderOptions): ProviderEntry {
    return entry("codex", options)
}

/** The user's own OpenRouter key — vaulted, or passed directly. */
export function OpenRouter(options?: ProviderOptions): ProviderEntry {
    return entry("openrouter", options)
}

/**
 * Language models on this machine, through a local Ollama daemon.
 *
 * Offered only while the daemon answers: an unreachable Ollama contributes a
 * visible failure, never a phantom model that resolves at prepare and dies
 * at the first call.
 */
export function Ollama(options?: ProviderOptions): ProviderEntry {
    return entry("ollama", options)
}

/**
 * Weights from the Hugging Face hub, run by a local runtime.
 *
 * A REGISTRY, not a runtime: the hub stores bytes, and executing them is
 * Axon's job. That is why this supplies the non-LLM kinds (ASR, VAD,
 * embeddings) rather than competing with Ollama for local language models,
 * and why it is the provider that will need a resource manager behind it.
 */
export function HuggingFace(options?: ProviderOptions): ProviderEntry {
    return entry("huggingface", options)
}

/**
 * Deterministic scripted inference, for tests and offline scaffolds.
 *
 * Takes the SCRIPT the mock driver takes — `Mock({ hello: "hi" })`,
 * `Mock(req => ...)` — because a mock with no script answers nothing useful,
 * and a test that had to declare a provider and separately hand a script to
 * something else would be describing one fact in two places.
 *
 * The script rides on the entry and is read back at build time. It is the one
 * provider whose declaration carries behaviour, which is exactly what makes it
 * a test double rather than a source of inference.
 */
export function Mock(script?: MockHandler | MockReply | ProviderOptions): ProviderEntry {
    // A bare options object and a reply MAP are both plain objects, so options
    // are distinguished by carrying ONLY known option keys.
    //
    // The `length > 0` guard is load-bearing: `Object.keys(fn)` is empty for a
    // function and `[].every()` is vacuously true, so a handler — the most
    // common form — was read as options and its script silently dropped. The
    // mock then echoed the prompt instead of answering, which looks like a
    // broken test rather than a discarded argument.
    const isOptions = script !== undefined
        && typeof script === "object"
        && Object.keys(script).length > 0
        && Object.keys(script).every(key => key === "key" || key === "url" || key === "slots")

    if (script === undefined || isOptions) return entry("mock", script as ProviderOptions | undefined)
    return { ...entry("mock"), script } as ProviderEntry & { script: unknown }
}

type BuildOpts = {
    cloud: EngineCloud
    /** Resolved agent environment — no process.env reads inside a provider. */
    env: Record<string, string | undefined>
}

const OLLAMA_DEFAULT_HOST = "http://localhost:11434"

/**
 * Turn one user declaration into a live provider.
 *
 * The seam every boot path shares, exactly as `resolveEngine()` is for the
 * single-engine world — so the TUI, a deployed runtime and a test all build
 * providers the same way and cannot drift.
 *
 * Throws on a name nothing implements. A typo in a profile must be loud: the
 * alternative is a user believing they declared Ollama and quietly running
 * every role on metered cloud inference.
 */
export function buildProvider(declared: ProviderEntry, opts: BuildOpts): AxonProvider {
    const slots = declared.slots

    // A hand-built driver, supplied directly. Tests that exercise engine
    // FAILURE construct one — a driver that throws, stalls, or returns a
    // malformed reply — and those doubles have no catalogue to implement.
    // Carried on the entry rather than through a separate seam so a test
    // declares inference exactly the way anything else does.
    const supplied = (declared as ProviderEntry & { driver?: { name?: string; create(res: never): unknown } }).driver
    if (supplied) return DirectProvider(declared.provider, supplied, opts)

    switch (declared.provider) {
        case "axon":
            return HostedProvider({
                name: "axon",
                cloud: opts.cloud,
                driver: model => AxonDriver({ model }).create({ env: opts.env, cloud: opts.cloud }),
                ...(slots !== undefined ? { slots } : {}),
            })

        case "codex":
            return HostedProvider({
                name: "codex",
                cloud: opts.cloud,
                driver: model => CodexDriver({ model }).create({ env: opts.env, cloud: opts.cloud }),
                ...(slots !== undefined ? { slots } : {}),
            })

        case "openrouter":
            return HostedProvider({
                name: "openrouter",
                cloud: opts.cloud,
                driver: model => OpenRouterDriver({ model }).create({ env: opts.env, cloud: opts.cloud }),
                ...(slots !== undefined ? { slots } : {}),
            })

        case "ollama":
            return OllamaProvider({
                host: declared.url ?? OLLAMA_DEFAULT_HOST,
                driver: model => OllamaDriver({ model }).create({ env: opts.env, cloud: opts.cloud }),
                ...(slots !== undefined ? { slots } : {}),
            })

        case "mock":
            return MockProvider((declared as ProviderEntry & { script?: unknown }).script)

        default:
            throw new EngineFailure({
                code: "INVALID_REQUEST",
                message: `PROVIDER_UNKNOWN: "${declared.provider}" — known providers: axon, codex, openrouter, ollama, mock`,
                retryable: false,
                provider: declared.provider,
            })
    }
}

/**
 * One hand-built driver, as a provider of exactly itself.
 *
 * Its capability is deliberately permissive: a test declaring a role with a
 * 200k context floor should exercise the wiring it is testing, not the
 * resolver's arithmetic, and the driver it supplied is the one it means to
 * run.
 */
function DirectProvider(
    name: string,
    def: { name?: string; create(res: never): unknown },
    opts: BuildOpts,
): AxonProvider {
    const capability = {
        id: def.name ?? name,
        provider: name,
        name: def.name ?? name,
        type: "generate" as const,
        in: ["text" as const],
        out: ["text" as const],
        context: Number.MAX_SAFE_INTEGER,
        structured: true,
    }

    return {
        name,
        async catalogue() { return [capability] },
        async resolve(ref: string) { return ref === capability.id ? capability : null },
        create() {
            return def.create({ env: opts.env, cloud: opts.cloud } as never) as ReturnType<AxonProvider["create"]>
        },
    }
}

/**
 * Scripted inference that satisfies any generate role.
 *
 * Its catalogue is one entry with deliberately generous limits, because a
 * test declaring a 200k-context role should exercise the resolver's wiring
 * rather than its arithmetic. Not `local`, so a test that also lists a real
 * local provider still prefers the real one.
 */
function MockProvider(script?: unknown): AxonProvider {
    const capability = {
        id: "mock",
        provider: "mock",
        name: "Mock",
        type: "generate" as const,
        in: ["text" as const],
        out: ["text" as const],
        context: 1_000_000,
        structured: true,
    }

    return {
        name: "mock",
        async catalogue() {
            return [capability]
        },
        async resolve(ref: string) {
            return ref === "mock" ? capability : null
        },
        create() {
            return MockDriver(script as never).create({ env: {}, cloud: undefined as never })
        },
    }
}
