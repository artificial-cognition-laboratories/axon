import type { AxonEngineDriver, EngineCapability } from "@arcforge/types"
import { EngineFailure } from "../shared"
import { fromOllamaCapabilities } from "./modalities"
import type { AxonProvider } from "./provider"

type OllamaOpts = {
    host: string
    driver(model: string): AxonEngineDriver
    slots?: number
}

/** What `/api/tags` reports about a model present on this machine. */
type TagsModel = {
    name: string
    size?: number
    details?: { family?: string; parameter_size?: string }
}

/**
 * Ollama's default concurrent request ceiling.
 *
 * The daemon serves requests in parallel but queues past its own limit, so a
 * fanned-out role that ignored this would not go faster — it would just
 * queue deeper. Stated as a number rather than left unbounded because the
 * honest answer for a machine with one GPU is "a few", and a cognet reading
 * `slots` to size a batch deserves a real figure.
 */
const OLLAMA_DEFAULT_SLOTS = 4

/**
 * Models on this machine, through a local Ollama daemon.
 *
 * Ollama is a registry AND a runtime: it holds its own weights in its own
 * format and manages their residency itself. That is why it needs nothing
 * from a resource manager — a local LLM here behaves like a hosted route
 * that happens to be on localhost.
 *
 * The catalogue reports what is PULLED, never the curated shelf of models a
 * user could install. Those are different questions: the shelf is a download
 * menu for a picker, and answering with it would resolve a role to weights
 * that are not on the disk.
 */
export function OllamaProvider(opts: OllamaOpts): AxonProvider {
    async function tags(): Promise<TagsModel[]> {
        const response = await fetch(`${opts.host}/api/tags`, { signal: AbortSignal.timeout(5_000) })
        if (!response.ok) {
            throw new EngineFailure({
                code: "TRANSPORT",
                message: `ollama: /api/tags answered ${response.status}`,
                retryable: true,
                provider: "ollama",
                status: response.status,
            })
        }
        const body = (await response.json()) as { models?: TagsModel[] }
        return body.models ?? []
    }

    /**
     * Ollama does not report modalities on /api/tags, so vision is inferred
     * from the family name — the same signal its own catalog encodes. Wrong
     * in the conservative direction: a vision model misread as text-only
     * simply does not fill a role that needs images.
     */
    function shapeOf(model: TagsModel) {
        const family = (model.details?.family ?? "").toLowerCase()
        const visual = ["llava", "gemma3", "llama3.2-vision", "qwen2-vl", "minicpm-v"].some(name => family.includes(name))
        return fromOllamaCapabilities(visual ? ["chat", "vision"] : ["chat"])
    }

    function capability(model: TagsModel): EngineCapability {
        const shape = shapeOf(model)
        return {
            id: model.name,
            provider: "ollama",
            name: model.name,
            type: shape.type,
            in: shape.in,
            out: shape.out,
            // Context is absent deliberately: /api/tags does not report it,
            // and absent means UNKNOWN rather than zero, so a local model is
            // never silently excluded from a role that names a window. A
            // wrong guess here would quietly delete every local model from
            // every serious cognet.
            local: true,
            slots: opts.slots ?? OLLAMA_DEFAULT_SLOTS,
            ...(model.size !== undefined ? { bytes: model.size } : {}),
        }
    }

    return {
        name: "ollama",

        async catalogue(): Promise<EngineCapability[]> {
            return (await tags()).map(capability)
        },

        /**
         * Ollama's registry accepts any name whether or not it is on the
         * curated shelf, so a reference this machine has not pulled is not
         * necessarily wrong — it is simply not here yet. Null says "not
         * available now"; pulling it is a user action, never something
         * resolution does behind their back on a metered connection.
         */
        async resolve(ref: string): Promise<EngineCapability | null> {
            const model = (await tags()).find(candidate => candidate.name === ref)
            return model ? capability(model) : null
        },

        create(capability: EngineCapability): AxonEngineDriver {
            return opts.driver(capability.id)
        },
    }
}
