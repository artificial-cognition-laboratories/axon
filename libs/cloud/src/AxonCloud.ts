import { Cloud } from "./cloud/cloud"
import { Reporting } from "./platform/reporting"
import { resolveDefaultBaseUrl } from "./platform/http"
import type { AttachOpts } from "./cloud/agents/agents"
import { Registry } from "./registry/registry"
import { Staff } from "./staff/staff"
import type { AuthSession } from "./user/auth/types"
import { User } from "./user/user"

type AxonCloudOpts = {
    /** AXON_API_KEY. Optional — registry browsing works logged-out; everything else fails loudly on use. */
    key?: string
    /** Backend base URL. Defaults to production; tests point this at staging. */
    baseUrl?: string
    /** A persisted session to adopt at construction — how the TUI re-hydrates a login across boots. */
    session?: AuthSession
    /** Allow AXON_CONNECT_TOKEN / AXON_API_KEY fallbacks. Defaults to true for server and development consumers. */
    environmentCredentials?: boolean
    /** Axon session identity — forwarded to Cognos so events share one trace tree. */
    sessionId?: string
    /**
     * "node" (default) — full surface, for the TUI/CLI. "browser" — drops
     * the two leaves that need real Node builtins (agent/module publish,
     * which read bundle files off local disk; Codex OAuth, which runs a
     * local callback server): both throw a clear error if called. Every
     * other verb (auth, billing, orgs, registry browsing, deployments) is
     * plain fetch() and works identically in both runtimes.
     */
    runtime?: "node" | "browser"
    /**
     * The backend refused this client's credential mid-session (401).
     *
     * A credential can die while the app runs — revoked from the web, expired
     * past refresh, account disabled — and nothing noticed: the boot check had
     * already passed, so the user stayed in an app whose every request failed
     * until they restarted. Subscribe to re-gate the UI the moment it happens.
     *
     * Observational: it cannot suppress the HttpError the caller still
     * receives. The auth ladder's own calls are excluded (see Http.auth).
     */
    onUnauthorized?: () => void

    /**
     * Crash reporting — 5xx and transport failures POST to /api/reports so
     * breakage is visible before a user reports it.
     *
     * On by default. It sends no user data (context is allowlisted and paths
     * are reduced to basenames — see scrubContext), never retries, and never
     * reports its own failures, so the worst case of leaving it on is a
     * dropped request. Set `false` to disable entirely.
     */
    reporting?: boolean

    /** Release string stamped on reports. Without it a report cannot say whether a crash is already fixed. */
    release?: string
}

/**
 * The Axon Cloud client. Three exposed top level domains only:
 *   user     — auth, billing, keys, orgs (the human's account)
 *   registry — public catalog: agents, modules, cognos deployments
 *   cloud    — platform services: cognos connection, stt, agent identity
 *
 * Construction never touches the network — a missing key or dead backend
 * fails at the call site that needs it, not at boot.
 */
export function AxonCloud(opts: AxonCloudOpts) {
    const runtime = opts.runtime ?? "node"

    // Built BEFORE User so it can be handed to Http as the failure observer.
    // It deliberately does not receive `user.http` — see Reporting(): sending
    // a report through the transport whose failures it reports is a loop.
    const reporting = Reporting({
        baseUrl: opts.baseUrl ?? resolveDefaultBaseUrl(),
        enabled: opts.reporting ?? true,
        ...(opts.release !== undefined ? { release: opts.release } : {}),
        platform: describePlatform(),
    })

    const user = User({
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        environmentCredentials: opts.environmentCredentials ?? true,
        ...(opts.onUnauthorized !== undefined ? { onUnauthorized: opts.onUnauthorized } : {}),
        onFailure: reporting.httpFailure,
        runtime,
    })

    const registry = Registry({ http: user.http, runtime })

    const cloud = Cloud({
        http: user.http,
    })

    const staff = Staff({ http: user.http })

    return {
        user: user,
        registry: registry,
        cloud: cloud,
        staff: staff,

        /**
         * The outbound crash channel. Exposed so a host that owns its own
         * failure paths (the TUI's top-level catch, the runtime's err() sink)
         * can report through the same client rather than building a second
         * one with its own endpoint and its own idea of what to scrub.
         */
        reporting: reporting,

        /**
         * Attach to a deployed agent instance by URL. Returns a handle whose
         * `request`/`stream` mirror the local agent surface, so product code
         * works against a remote agent unchanged. The handle is bound to one
         * instance; call attach again for another. This is the top-level
         * verb because it is the primary way a consumer reaches a live agent.
         *
         * Pass `agentId` and a connect token is minted for that agent and
         * presented to it — a capability valid for one agent and a few
         * minutes, not the caller's own credential. THE CALLER'S CREDENTIAL IS
         * NEVER SENT TO AN AGENT: it is valid against every other agent and
         * the whole backend API, so handing it to an agent process would make
         * that agent able to act as the user everywhere. It is used here only
         * to ask the control plane for the capability.
         *
         * An explicit `token` overrides minting, for a caller that already
         * holds one.
         *
         * With NEITHER, the attach itself discovers the audience: the agent's
         * ungated `/_axon/health` reports its `agentId` when it enforces, and
         * `agents.attach` mints from that. So a caller holding nothing but a
         * URL — `:attach <url>`, and now `axon attach` — still authenticates.
         * This layer's `agentId` remains useful for a caller that already
         * knows the id (a deployment picked off the shelf) and can skip a
         * round trip.
         */
        async attach(url: string, attachOpts?: AttachOpts) {
            const token = attachOpts?.token
                ?? (attachOpts?.agentId ? await cloud.agents.connect?.token(attachOpts.agentId) : undefined)
            return cloud.agents.attach(url, { ...attachOpts, ...(token ? { token } : {}) })
        },
    }
}

export type AxonCloudClient = ReturnType<typeof AxonCloud>

/**
 * A coarse runtime descriptor for crash reports — "bun-1.1.38/linux".
 *
 * Deliberately narrow. It answers "does this only break on one runtime or
 * platform", which is a question that has actually saved debugging time, and
 * nothing else. It must NEVER carry a hostname, username, locale, or full
 * version string with a build id — those identify a person, not a platform,
 * and a crash reporter that fingerprints its users is a different product
 * than the one we are building.
 *
 * Browser builds report only "browser": a user-agent string is an identifier.
 */
function describePlatform(): string | undefined {
    // Read off globalThis rather than the ambient globals: this package
    // builds without the DOM lib (it targets Node first), so `document` is
    // not a declared name here even though the browser build reaches it.
    const runtime = globalThis as {
        Bun?: { version: string }
        process?: NodeJS.Process
        document?: unknown
    }

    if (runtime.Bun?.version) {
        return `bun-${runtime.Bun.version}/${runtime.process?.platform ?? "unknown"}`
    }
    if (runtime.process?.versions?.node) {
        return `node-${runtime.process.versions.node}/${runtime.process.platform}`
    }
    if (runtime.document !== undefined) return "browser"
    return undefined
}
