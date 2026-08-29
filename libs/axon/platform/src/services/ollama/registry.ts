import { err } from "@arcforge/err"
import { CATALOG, families } from "./catalog"
import type { CatalogModel } from "./types"

/** The upstream Ollama registry. Speaks the OCI distribution protocol. */
const REGISTRY = "https://registry.ollama.ai/v2"
const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json"

type Manifest = {
    layers?: Array<{ mediaType: string; size: number }>
}

type RegistryOpts = {
    /** Override the upstream base URL. Tests point this at a local stand-in. */
    baseUrl?: string
}

/**
 * Registry — what is available to download, and how big it is.
 *
 * Two halves, because the upstream gives us two very different things:
 *
 *   browse()   the curated catalog (see catalog.ts — Ollama publishes no
 *              search API, so there is nothing to enumerate)
 *   resolve()  a live manifest lookup, which works for ANY name
 *
 * That split is why a user is never fenced in by the shelf: a palette lists
 * `browse()`, but typing `mistral-small:24b` still resolves, reports its real
 * size, and pulls.
 */
export function Registry(opts: RegistryOpts = {}) {
    const baseUrl = (opts.baseUrl ?? REGISTRY).replace(/\/+$/, "")

    /**
     * A bare name means the `latest` tag, and an unqualified model lives under
     * `library/` — the same defaulting `ollama pull` applies, so a user's
     * mental model of a name matches ours exactly.
     */
    function parse(name: string): { repository: string; tag: string } {
        const [path, tag = "latest"] = name.split(":")
        const repository = path!.includes("/") ? path! : `library/${path}`
        return { repository: repository, tag: tag }
    }

    async function manifest(name: string): Promise<Manifest | null> {
        const { repository, tag } = parse(name)

        let response: Response
        try {
            response = await fetch(`${baseUrl}/${repository}/manifests/${tag}`, {
                headers: { accept: MANIFEST_ACCEPT },
            })
        } catch (cause) {
            throw err("OLLAMA_REGISTRY_UNREACHABLE", {
                detail: `could not reach ${baseUrl} — check the network connection`,
                context: { name: name },
                cause: cause,
            })
        }

        // 404 is a real answer: no such model. Anything else is a fault.
        if (response.status === 404) return null
        if (!response.ok) {
            throw err("OLLAMA_REGISTRY_UNREACHABLE", {
                detail: `${name}: ${response.status} ${response.statusText}`,
                context: { name: name, status: response.status },
            })
        }

        return await response.json() as Manifest
    }

    return {
        /** The curated shelf. A palette's list. */
        browse(): CatalogModel[] {
            return CATALOG.map(entry => ({ ...entry }))
        },

        /** Catalog entries for one family, e.g. every gemma3 variant. */
        variants(model: string): CatalogModel[] {
            return CATALOG.filter(entry => entry.model === model).map(entry => ({ ...entry }))
        },

        families: families,

        /**
         * Confirm a model exists upstream and report its real download size.
         *
         * Null when the registry has no such name — a mistyped tag is
         * information, not a fault, and the caller reports it as such.
         *
         * The size is the sum of the layer sizes, which is what actually
         * crosses the network. It is asked for rather than recorded because a
         * tag is mutable: `gemma3:4b` is a different number of bytes today than
         * it was at the last release.
         */
        async resolve(name: string): Promise<{ name: string; size: number } | null> {
            const found = await manifest(name)
            if (!found) return null

            const size = (found.layers ?? []).reduce((total, layer) => total + layer.size, 0)
            return { name: name, size: size }
        },

        /** Whether the registry serves this name at all. */
        async exists(name: string): Promise<boolean> {
            return (await manifest(name)) !== null
        },
    }
}

export type RegistryT = ReturnType<typeof Registry>
