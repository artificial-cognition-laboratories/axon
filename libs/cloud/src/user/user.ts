import { Http } from "../platform/http"
import { Activity } from "./activity"
import { Auth } from "./auth"
import { Billing } from "./billing"
import { Deployments } from "./deployments"
import { Keys } from "./keys"
import { Orgs } from "./orgs"
import { Overview } from "./overview"
import { Pins } from "./pins"
import { Profile } from "./profile"
import { Starred } from "./starred"
import { Vault } from "./vault"

type UserOpts = {
    key?: string
    /** Backend base URL — defaults to production inside Http. */
    baseUrl?: string
    /** Persisted session to adopt at construction (see Auth). */
    session?: import("./auth/types").AuthSession
    /** Whether Auth may read AXON_CONNECT_TOKEN / AXON_API_KEY from process.env. */
    environmentCredentials: boolean
    /** "browser" drops the Node-only leaves (vault connect's local OAuth callback) — see Vault. */
    runtime: "node" | "browser"
    /** Fired when the backend refuses the credential mid-session — see HttpOpts. */
    onUnauthorized?: () => void
    /** Fired on 5xx and transport failures, for crash reporting — see HttpOpts. */
    onFailure?: (error: unknown, path: string, method: string) => void
}

/**
 * Orchestrator — same pattern as AxonServer. Auth owns the credential and
 * resolves it live; Http reads it per request; every resource module calls
 * through the shared Http instance. Nothing here does work itself.
 *
 * Auth and Http reference each other (flows need transport, transport needs
 * the credential) — resolved lazily in both directions: Auth gets `() => http`
 * (device endpoints are unauthenticated, so ordering never matters), Http
 * gets `() => auth.token`.
 */
export function User(opts: UserOpts) {
    const auth = Auth({
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        environmentCredentials: opts.environmentCredentials,
        http: () => http,
    })

    const http = Http({
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        token: () => auth.token,
        ...(opts.onUnauthorized !== undefined ? { onUnauthorized: opts.onUnauthorized } : {}),
        ...(opts.onFailure !== undefined ? { onFailure: opts.onFailure } : {}),
    })

    const billing = Billing({ http: http })
    const keys = Keys({ http: http })
    const orgs = Orgs({ http: http })
    const vault = Vault({ http: http, runtime: opts.runtime })
    const activity = Activity({ http: http, path: () => "/api/user/activity" })
    const starred = Starred({ http: http })
    const profile = Profile({ http: http })
    const pins = Pins({ http: http })
    const deployments = Deployments({ http: http })
    const overview = Overview({ http: http })

    return {
        auth: auth,
        http: http,
        billing: billing,
        keys: keys,
        orgs: orgs,
        vault: vault,
        activity: activity,
        starred: starred,
        profile: profile,
        pins: pins,
        deployments: deployments,
        overview: overview,
    }
}

export type UserHandle = ReturnType<typeof User>
