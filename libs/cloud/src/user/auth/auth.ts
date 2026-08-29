import type { HttpClient } from "../../platform/http"
import { record } from "../../platform/parse"
import { DeviceFlow } from "./device"
import { jwt } from "./jwt"
import { parseAuthUser } from "./types"
import type { AuthSession, AuthUser, DeviceAuthorization } from "./types"

const REFRESH_BUFFER_MS = 5 * 60 * 1000

/** A JWT has three dot-separated parts; an axon_... API key has none. */
function isJwt(token: string): boolean {
    return token.split(".").length === 3
}

type AuthOpts = {
    /** The sole credential (blueprint.env.AXON_API_KEY, or a persisted token handed back by the layer above). */
    key?: string
    /** A previously persisted session to adopt as the live one — refresh() handles staleness. */
    session?: AuthSession
    /** Whether deployment/development credentials may be resolved from process.env. */
    environmentCredentials: boolean
    /** Lazy — Auth is constructed before Http; flows resolve it on use. */
    http: () => HttpClient
}

type LoginOpts = {
    /** Shown the verification step (URL + user code) — the TUI renders it, tests log it. */
    /**
     * Show the user their code. May be async — an automated caller (tests, a
     * scripted approval) does the approving HERE, and login() awaits it before
     * polling. Typed `=> void` originally, which silently dropped the returned
     * promise: polling then raced the approval, lost, and paid a full poll
     * interval waiting for a state the caller had not reached yet.
     */
    onVerification: (authorization: DeviceAuthorization) => void | Promise<void>
    /** Login hint (email) forwarded to the backend. */
    hint?: string
    signal?: AbortSignal
}

/**
 * Auth — one in-memory session, no persistence. This layer authenticates
 * the client; storing credentials across boots is the caller's concern
 * (the TUI persists what login() returns and re-hydrates next boot via
 * AxonCloud({ key })). No key still yields a working client — just an
 * unauthenticated one: public surfaces work, the rest 401s loudly.
 *
 * Credential ladder (checked live, per access):
 *   token:  AXON_CONNECT_TOKEN env  →  session accessToken  →  opts.key  →  AXON_API_KEY env
 *   apiKey: opts.key  →  AXON_API_KEY env   (never a JWT)
 *
 * The env rungs make a deployed container fully authenticated with zero
 * flows; login() covers the interactive human.
 */
export function Auth(opts: AuthOpts) {
    const device = DeviceFlow({ http: opts.http })

    let session: AuthSession | undefined = opts.session
    /** Set only mid-login: a token approved by the device flow, awaiting the me() call that resolves its user before a real AuthSession can exist. */
    let pendingToken: string | undefined

    function adopt(accessToken: string, user: AuthUser): AuthSession {
        pendingToken = undefined
        session = {
            accessToken,
            expiresAt: jwt.token.parse(accessToken),
            user,
        }
        return session
    }

    /** Fetch identity from the backend; syncs the live session's user when one exists. */
    async function me(): Promise<AuthUser> {
        // auth.get, not get: a 401 here is this call's own answer (the
        // credential is dead, which is exactly what validate() asked), so it
        // must not also fire the global session-died observer — that observer
        // calls validate(), which calls this.
        const raw = await opts.http().auth.get<Record<string, unknown>>("/api/user/me/session")
        const user = parseAuthUser(record(raw, "session").user)
        if (session) session = { ...session, user }
        return user
    }

    return {
        /** Bearer credential for backend HTTP — resolved live so login/logout/refresh are picked up. */
        get token(): string | undefined {
            return (opts.environmentCredentials ? process.env.AXON_CONNECT_TOKEN : undefined)
                ?? session?.accessToken
                ?? pendingToken
                ?? opts.key
                ?? (opts.environmentCredentials ? process.env.AXON_API_KEY : undefined)
        },

        /** Axon API key for ws3 engine connections and ingest — never a JWT. */
        get apiKey(): string | undefined {
            return opts.key ?? (opts.environmentCredentials ? process.env.AXON_API_KEY : undefined)
        },

        /** Identity of the live session. Undefined when running on a bare key or logged out. */
        get user(): AuthUser | undefined {
            return session?.user
        },

        /**
         * True when the session token is expired or within the refresh
         * buffer — call refresh(). Only meaningful for JWT sessions (three
         * dot-separated parts) — an axon_... API key has no exp claim and
         * doesn't expire on a rolling clock, so it is never stale. Without
         * this check, jwt.token.parse()'s malformed-token fallback (a fake
         * "24h from now") would make every API-key session silently go
         * stale once a day for no real reason.
         */
        get stale(): boolean {
            if (!session) return false
            if (!isJwt(session.accessToken)) return false
            return jwt.token.isExpired(session.accessToken, REFRESH_BUFFER_MS)
        },

        /**
         * Device-flow login. Requests authorization, hands the verification
         * step to the caller, polls until approved. The poll response only
         * carries the token — identity is resolved with one follow-up call
         * to /api/user/me/session. `token` (above) falls back to
         * `pendingToken` so Http picks up the new token for that one call,
         * before any AuthSession (which requires a user) can exist.
         */
        async login(loginOpts: LoginOpts): Promise<AuthSession> {
            const authorization = await device.authorize(loginOpts.hint)
            // Awaited: a caller that approves inline finishes before the first
            // poll, so an already-approved code is picked up immediately
            // instead of after one interval. A human-facing caller returns
            // void and this is a no-op.
            await loginOpts.onVerification(authorization)

            const approved = await device.wait(authorization, loginOpts.signal)
            pendingToken = approved.accessToken
            const user = await me()
            return adopt(approved.accessToken, user)
        },

        /**
         * Exchange the current token for a fresh one before it expires.
         * Adopts and returns the new session — caller re-persists it.
         */
        async refresh(): Promise<AuthSession> {
            if (!session) throw new Error("cannot refresh: no live session — log in first")

            // Same reasoning as me(): a refused refresh IS the answer here.
            const raw = await opts.http().auth.post<Record<string, unknown>>("/api/auth/refresh", {})
            const accessToken = raw.access_token ?? raw.accessToken
            if (typeof accessToken !== "string") throw new Error("invalid refresh response: missing access_token")

            return adopt(accessToken, raw.user ? parseAuthUser(raw.user) : session.user)
        },

        me: me,

        /**
         * Approve a pending CLI device code — the browser side of device
         * flow. Requires a live session (Http sends the bearer token).
         */
        approve: device.approve,

        /**
         * Adopt an already-known session as the live one — no wire call.
         * For a caller (the TUI) switching between on-disk profiles: it
         * already has each profile's persisted AuthSession, so there is no
         * flow to run, only an in-place identity swap on the same client.
         */
        adopt(newSession: AuthSession): void {
            session = newSession
            pendingToken = undefined
        },

        /** Drop the live session. (Server-side invalidation when the backend grows the endpoint.) */
        async logout(): Promise<void> {
            session = undefined
        },
    }
}

export type AuthHandle = ReturnType<typeof Auth>
