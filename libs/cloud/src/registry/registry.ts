import type { HttpClient } from "../platform/http"
import { Agents } from "./agents"
import { Artifacts } from "./artifacts"
import { Directory } from "./directory"
import { Models } from "./models"
import { Modules } from "./modules"
import { Profile } from "./profile"
import { Scopes } from "./scopes"

type RegistryOpts = {
    http: HttpClient
    runtime: "node" | "browser"
}

/**
 * Catalog search — agents, modules, cognets, benches. Doesn't require auth;
 * browsing the public registry works logged-out (Http sends no Authorization
 * header when no key is resolved).
 *
 * `artifacts` is the general surface: one namespace, five kinds, and every
 * verb that does not care which — record, versions, publish, stars, stats,
 * search, resolve. `of(kind)` binds it for callers that know what they hold.
 *
 * `agents` and `modules` are now ONLY the verbs genuinely specific to them:
 * deployment and npm-style install resolution. They used to carry full
 * parallel CRUD surfaces over the same rows, which is the drift this comment
 * already described and the code no longer matched — and it was not merely
 * duplication: three route families over one table is what allowed an
 * agent-bound key to be refused at the agents door and admitted at the
 * artifacts one.
 */
export function Registry(opts: RegistryOpts) {
    const artifacts = Artifacts({ http: opts.http, runtime: opts.runtime })

    return {
        artifacts: artifacts,
        modules: Modules({ http: opts.http }),
        agents: Agents({ http: opts.http, runtime: opts.runtime }),
        // cognos: Cognos({ http: opts.http }), // deprecated
        /** model catalogs — axon (billed), openai (Codex family), openrouter; all public */
        models: Models({ http: opts.http }),
        /**
         * Namespaces — "@axon", "@cody" — and what they publish. One surface
         * for users and orgs; `profile` below is the older user-only read
         * path kept until its callers move over.
         */
        scopes: Scopes({ http: opts.http }),
        profile: Profile({ http: opts.http }),
        /** Public people + org search — the directory half of platform search. */
        directory: Directory({ http: opts.http }),

        /**
         * Resolve a `@scope/name` across the shared namespace to a downloadable
         * artifact of any kind. One entry point so callers (clone/fork) never
         * need to know the kind up front.
         */
        resolve: artifacts.resolve,
    }
}

export type RegistryHandle = ReturnType<typeof Registry>

/**
 * Time range for a registry item's activity chart (stars/installs). Selected
 * by the in-chart tabs; forwarded to the stats endpoint as `?range=`.
 *   week  → 7 daily points
 *   year  → ~52 weekly points
 *   total → all-history monthly points
 */
export type ActivityRange = "week" | "year" | "total"
