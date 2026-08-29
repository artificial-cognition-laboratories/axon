import { Http } from "./http"
import { Models } from "./models"
import { Registry } from "./registry"
import type { CatalogModel, OllamaStatus } from "./types"

/** Ollama's own default. Overridable for a daemon on another host or port. */
const DEFAULT_HOST = "http://localhost:11434"

type OllamaOpts = {
    /** Daemon base URL. Defaults to OLLAMA_HOST, then http://localhost:11434. */
    host?: string
    /** Upstream registry base URL. Tests point this at a local stand-in. */
    registryUrl?: string
}

/**
 * Ollama — local models, programmatically.
 *
 * A user running Axon against local inference has three questions: what can I
 * run, what do I have, and how do I get more. This answers all three:
 *
 *   registry  what is available to download (curated — Ollama has no search
 *             API) plus live resolution of ANY name against the upstream
 *   models    what is on this machine, what is loaded, and pulling more
 *
 * Ollama owns the bytes. It has its own blob store, layer deduplication and
 * garbage collection, so nothing here manages files — a second store competing
 * with `ollama pull` would be a bug, not a feature.
 *
 * Construction touches no network. A machine with no Ollama installed
 * constructs this happily and fails at the first call that needs the daemon,
 * with OLLAMA_UNAVAILABLE naming the fix.
 */
export function Ollama(opts: OllamaOpts = {}) {
    const host = opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST

    const http = Http({ host: host })
    const models = Models({ http: http })
    const registry = Registry(opts.registryUrl !== undefined ? { baseUrl: opts.registryUrl } : {})

    return {
        host: http.host,
        models: models,
        registry: registry,

        /**
         * Whether the daemon is reachable.
         *
         * The one verb that answers instead of throwing: "is Ollama installed"
         * is a question every caller asks BEFORE deciding to use it, so an
         * unreachable daemon is the expected answer half the time rather than a
         * fault. Every other verb throws.
         */
        async status(): Promise<OllamaStatus> {
            try {
                const { version } = await http.json<{ version: string }>("/api/version")
                return { running: true, version: version }
            } catch (cause) {
                return { running: false, reason: cause instanceof Error ? cause.message : String(cause) }
            }
        },

        /**
         * The catalog, marked up with what is already installed and what each
         * entry actually weighs — the shape a model palette renders.
         *
         * Sizes come from the live registry in parallel, and a lookup that
         * fails leaves `size` absent rather than failing the whole list: a
         * network blip should grey out one number, not empty the palette.
         */
        async available(): Promise<CatalogModel[]> {
            const [entries, installed] = await Promise.all([
                registry.browse(),
                models.list().then(list => new Set(list.map(model => model.name))).catch(() => new Set<string>()),
            ])

            return Promise.all(entries.map(async entry => {
                const resolved = await registry.resolve(entry.name).catch(() => null)
                return {
                    ...entry,
                    installed: installed.has(entry.name),
                    ...(resolved ? { size: resolved.size } : {}),
                }
            }))
        },
    }
}

export type OllamaT = ReturnType<typeof Ollama>
