import type { HttpClient } from "../../platform/http"
import { record, str } from "../../platform/parse"
import type { ResolvedModule } from "./types"

type ModulesOpts = {
    http: HttpClient
}

/**
 * Modules — npm-style install resolution, and nothing else.
 *
 * Everything else a module is lives on `registry.artifacts.of("module")`: a
 * module is a registry artifact, and its record, versions, publishing, stars
 * and stats are the same routes and the same parsing as every other kind.
 * This module used to restate all of it against a parallel `/api/modules/*`
 * family over the same rows — the duplication that let an agent-bound key
 * reach a sibling through whichever door was unguarded.
 *
 * `resolve()` survives because its payload genuinely differs: the install path
 * wants a name resolved to a downloadable tarball, which is not the generic
 * `ResolvedArtifact` shape and is consumed by the module installer rather than
 * by anything browsing the catalog.
 */
export function Modules(opts: ModulesOpts) {
    return {
        /** Resolve a name to its latest (or pinned) version + download URL — the install path. */
        async resolve(name: string, version?: string): Promise<ResolvedModule> {
            const params = new URLSearchParams({ name })
            if (version) params.set("version", version)

            const raw = record(await opts.http.get(`/api/registry/modules/resolve?${params}`), "resolved module")
            return {
                moduleId: str(raw, "moduleId"),
                name: str(raw, "name"),
                version: str(raw, "version"),
                downloadUrl: str(raw, "downloadUrl"),
            }
        },
    }
}

export type ModulesHandle = ReturnType<typeof Modules>
