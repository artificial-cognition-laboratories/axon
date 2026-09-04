import type { EngineCloud, ProviderEntry } from "@arcforge/types"
import { HostedProvider, OllamaProvider, type AxonProvider, type LocalRuntime } from "../catalogue"
import { EngineFailure } from "../shared"
import { AxonDriver, CodexDriver, OllamaDriver, OpenRouterDriver, MockDriver } from "../drivers"
import { DIRECT_PROVIDERS } from "../aisdk/catalogue"
import { DirectProvider } from "../aisdk"
import type { MockInput, MockReply } from "../mock"

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

/**
 * Inference available on this machine, managed by Axond.
 *
 * Local is implicit: declaring it is only for overriding policy such as the
 * concurrency ceiling. The runtime and source format stay behind Axond.
 */
export function Local(options?: ProviderOptions): ProviderEntry {
    return entry("local", options)
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
/**
 * `MockInput`, not `MockHandler | MockReply` — the map form
 * (`Mock({ hello: "hi" })`) is the one the docs lead with and the one the
 * implementation below explicitly handles ("a bare options object and a reply
 * MAP are both plain objects"), but the type omitted it. Every call site using
 * it was an error nobody saw, because these tests were not typechecked.
 *
 * `MockReply` stays in the union for the bare single-step form
 * (`Mock("hi")`, `Mock(run("..."))`), which `MockInput` does not cover.
 */
export function Mock(script?: MockInput | MockReply | ProviderOptions): ProviderEntry {
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

/**
 * Direct BYOK providers — the user's own key, straight to the vendor.
 *
 * One factory each rather than a single `Direct("anthropic")`, because a
 * profile should read like the product: `providers: [Anthropic(), Groq()]`,
 * not `[Direct({ provider: "anthropic" })]`. That the transport underneath is
 * the Vercel AI SDK is an implementation detail of this package and must
 * never appear in a user's config.
 *
 * ORDER IN THE LIST IS MEANINGFUL. One model is often reachable through
 * several of these plus `Axon()`, and the declared order is what decides
 * which route a role binds to — `[Anthropic(), Axon()]` means "my key first,
 * managed as the fallback". See `preference()` in ../resolver/match.ts.
 *
 * Credentials come from the agent's resolved environment (the variable each
 * vendor's own tooling already uses) or from `{ key }` on the declaration.
 * Unlike `OpenRouter()` and `Codex()`, these are NOT vaulted yet: a deployed
 * agent needs the key in its deployment environment, or should use a vaulted
 * route instead.
 */

/** Anthropic's API, with your own key. `ANTHROPIC_API_KEY`. */
export function Anthropic(options?: ProviderOptions): ProviderEntry {
    return entry("anthropic", options)
}

/** OpenAI's API, with your own key. `OPENAI_API_KEY`. */
export function OpenAI(options?: ProviderOptions): ProviderEntry {
    return entry("openai", options)
}

/** Google's Gemini API, with your own key. `GOOGLE_GENERATIVE_AI_API_KEY`. */
export function Google(options?: ProviderOptions): ProviderEntry {
    return entry("google", options)
}

/** Groq's inference API, with your own key. `GROQ_API_KEY`. */
export function Groq(options?: ProviderOptions): ProviderEntry {
    return entry("groq", options)
}

/** Cerebras inference, with your own key. `CEREBRAS_API_KEY`. */
export function Cerebras(options?: ProviderOptions): ProviderEntry {
    return entry("cerebras", options)
}

/** Mistral's API, with your own key. `MISTRAL_API_KEY`. */
export function Mistral(options?: ProviderOptions): ProviderEntry {
    return entry("mistral", options)
}

/** DeepSeek's API, with your own key. `DEEPSEEK_API_KEY`. */
export function DeepSeek(options?: ProviderOptions): ProviderEntry {
    return entry("deepseek", options)
}

/** xAI's Grok API, with your own key. `XAI_API_KEY`. */
export function XAI(options?: ProviderOptions): ProviderEntry {
    return entry("xai", options)
}

/** Perplexity's API, with your own key. `PERPLEXITY_API_KEY`. */
export function Perplexity(options?: ProviderOptions): ProviderEntry {
    return entry("perplexity", options)
}

/** Z.AI's API, with your own key. `ZAI_API_KEY`. */
export function ZAI(options?: ProviderOptions): ProviderEntry {
    return entry("zai", options)
}

/**
 * Moonshot's Kimi API, with your own key. `MOONSHOT_API_KEY`.
 *
 * Reached through Moonshot's OpenAI-compatible endpoint — there is no
 * first-party AI SDK package. `url` overrides the default endpoint.
 */
export function Moonshot(options?: ProviderOptions): ProviderEntry {
    return entry("moonshot", options)
}

type BuildOpts = {
    cloud: EngineCloud
    /** Resolved agent environment — no process.env reads inside a provider. */
    env: Record<string, string | undefined>
    /** The machine-local inference bridge, supplied by the host when available. */
    local?: LocalRuntime
}

const OLLAMA_DEFAULT_HOST = "http://localhost:11434"

/**
 * The only providers an offline run may build.
 *
 * An ALLOWLIST, not a list of metered ones: `DIRECT_PROVIDERS` is a table that
 * grows, and a new BYOK route added to it must be refused offline by default
 * rather than by someone remembering to add it here. `mock` is local and
 * scripted; `ollama` runs on this machine and costs nothing. A supplied driver
 * never reaches the switch at all.
 */
const OFFLINE_PROVIDERS = new Set(["mock", "ollama", "local"])

/**
 * Turn one user declaration into a live provider.
 *
 * The seam every boot path shares — the TUI, a deployed runtime and a test
 * all build providers the same way and cannot drift.
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
    if (supplied) return SuppliedProvider(declared.provider, supplied, opts)

    // A test run must never reach a metered provider.
    //
    // `AXON_NO_NETWORK_INFERENCE` is set by the test preloads. It exists
    // because a fixture asking for offline inference had no way to ENFORCE it:
    // a declaration that failed to bind fell through to the profile's pool,
    // which in a test carries the developer's real credentials. Fourteen
    // fixtures declared a mock engine through a removed config field, resolved
    // against live OpenRouter instead, and billed a real account on every
    // suite run — silently, because a working agent on the wrong provider looks
    // exactly like a working agent.
    //
    // Refused HERE rather than at the config seam because this is where every
    // boot path converges: whatever route a test took to ask for inference, a
    // metered provider is built through this function or not at all.
    // `process.env`, not `opts.env`: the latter is the AGENT's resolved
    // environment, built from nothing and deliberately not inherited from this
    // process. This guard is about the process actually holding the credential
    // and making the call — the supervisor — so it reads the environment that
    // process was started with.
    if (process.env.AXON_NO_NETWORK_INFERENCE === "true" && !OFFLINE_PROVIDERS.has(declared.provider)) {
        throw new Error(
            `NETWORK_INFERENCE_IN_TEST: refusing to build the "${declared.provider}" provider — `
            + "this run is offline (AXON_NO_NETWORK_INFERENCE). A test reaching a metered provider "
            + "is either a fixture that meant to declare `providers: [Mock()]` and did not bind, "
            + "or a test that should be asking for a supplied driver.",
        )
    }

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

        case "local":
            return LocalProvider(opts.local, slots)

        case "ollama":
            return OllamaProvider({
                host: declared.url ?? OLLAMA_DEFAULT_HOST,
                driver: model => OllamaDriver({ model }).create({ env: opts.env, cloud: opts.cloud }),
                ...(slots !== undefined ? { slots } : {}),
            })

        case "mock":
            return MockProvider((declared as ProviderEntry & { script?: unknown }).script)

        default: {
            // Direct BYOK routes, reached through the AI SDK. A table lookup
            // rather than a case each: every one of them differs only in which
            // package it loads and which env var holds the key, so a switch
            // arm per provider would be the same six lines transcribed N
            // times. See ../aisdk/catalogue.
            const direct = DIRECT_PROVIDERS[declared.provider]
            if (direct) {
                return DirectProvider({
                    definition: direct,
                    cloud: opts.cloud,
                    env: opts.env,
                    ...(declared.key !== undefined ? { key: declared.key } : {}),
                    ...(declared.url !== undefined ? { url: declared.url } : {}),
                    ...(slots !== undefined ? { slots } : {}),
                })
            }
            const known = ["axon", "local", "codex", "openrouter", "ollama", "mock", ...Object.keys(DIRECT_PROVIDERS)]
            throw new EngineFailure({
                code: "INVALID_REQUEST",
                message: `PROVIDER_UNKNOWN: "${declared.provider}" — known providers: ${known.join(", ")}`,
                retryable: false,
                provider: declared.provider,
            })
        }
    }
}

/**
 * One hand-built driver, as a provider of exactly itself.
 *
 * Named for what it wraps — a driver SUPPLIED on the declaration — rather
 * than "direct", which now means a BYOK route through the AI SDK. Two
 * providers called the same thing in one file is how a test double ends up
 * on a billing path.
 *
 * Its capability is deliberately permissive: a test declaring a role with a
 * 200k context floor should exercise the wiring it is testing, not the
 * resolver's arithmetic, and the driver it supplied is the one it means to
 * run.
 */
/**
 * The one machine-local route. A host without Axond still builds it safely as
 * an empty provider; that preserves ordinary cloud/mock boots while making a
 * local-capable host authoritative for both discovery and execution.
 */
function LocalProvider(local: LocalRuntime | undefined, slots: number | undefined): AxonProvider {
    const empty: LocalRuntime = {
        catalogue: async () => [],
        run: async () => { throw new Error("LOCAL_RUNTIME_UNAVAILABLE") },
    }
    const runtime = local ?? empty

    const catalogue = async () => (await runtime.catalogue()).map(capability => ({
        ...capability,
        provider: "local",
        ...(slots !== undefined ? { slots } : {}),
    }))

    return {
        name: "local",
        catalogue,
        async resolve(ref) {
            return (await catalogue()).find(capability => capability.id === ref) ?? null
        },
        create(capability) {
            return {
                async *stream(request) {
                    const { Collect } = await import("../shared")
                    const { extractUserText } = await import("../mock")
                    const collect = Collect({ provider: "local", model: capability.id })
                    const text = await runtime.run(capability.id, extractUserText(request))
                    const event = collect.feed({ type: "text:delta", content: text })
                    if (event) yield event
                    yield collect.done({ ...(request.signal ? { signal: request.signal } : {}) })
                },
            }
        },
    }
}

function SuppliedProvider(
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
 * ── A provider with MODELS, not a single model ──────────────────────────────
 *
 * Mock is a provider like any other, and it was modelled as though it were one
 * model — which is why the pin read `mock:mock`, the same word twice because
 * the catalogue held one hardcoded capability named after its own provider.
 *
 * It offers two:
 *
 *   mock:default  the standard command set (see MOCK_COMMANDS) — the UI
 *                 surfaces that are otherwise hard to provoke on purpose.
 *                 Always present, because mock is in every pool.
 *   mock:custom   the script the user passed to `Mock(...)`, when they passed
 *                 one. ADDED, never replacing default: declaring your own
 *                 replies should not cost you every standard command, and the
 *                 old behaviour silently did exactly that.
 *
 * Capabilities carry deliberately generous limits, because a test declaring a
 * 200k-context role should exercise the resolver's wiring rather than its
 * arithmetic. Not `local`, so a test that also lists a real local provider
 * still prefers the real one.
 */
function MockProvider(script?: unknown): AxonProvider {
    const capability = (id: string, name: string) => ({
        id,
        provider: "mock",
        name,
        type: "generate" as const,
        in: ["text" as const],
        out: ["text" as const],
        context: 1_000_000,
        structured: true,
    })

    const standard = capability("default", "Mock")
    const custom = script === undefined ? null : capability("custom", "Mock (custom)")

    /**
     * The USER'S model leads when they supplied one.
     *
     * Catalogue order is preference order, so listing `default` first made it
     * win every unpinned role — and `Mock(handler)` silently ran the standard
     * commands instead of the handler. That is what `Mock(...)` has always
     * meant and what every test relies on: passing a script makes THAT the
     * mock.
     *
     * `default` stays in the catalogue behind it, so the standard commands are
     * still reachable by pinning `mock:default` — which is the gain over the
     * old behaviour, where a declared script replaced them outright.
     */
    const models = custom ? [custom, standard] : [standard]

    return {
        name: "mock",
        async catalogue() {
            return models
        },
        async resolve(ref: string) {
            /**
             * `mock` still resolves, to default.
             *
             * Every existing pin, test fixture and doc example says `mock:mock`
             * or bare `mock`. Breaking those to rename a model would be a
             * migration paid by every caller for a spelling — so the old name
             * keeps working and points at the model it always meant.
             */
            if (ref === "mock" || ref === "default") return standard
            if (ref === "custom") return custom
            return models.find(model => model.id === ref) ?? null
        },
        create(capability) {
            /**
             * The SCRIPT is chosen by WHICH MODEL WON.
             *
             * `create()` is handed the capability resolution picked, so
             * `mock:custom` runs what the user wrote and everything else runs
             * the standard set. Reading it here rather than closing over one
             * script is what makes the two models actually different — without
             * it they would be two catalogue entries sharing one behaviour.
             */
            const chosen = capability.id === "custom" ? script : undefined
            return MockDriver(chosen as never).create({ env: {}, cloud: undefined as never })
        },
    }
}
