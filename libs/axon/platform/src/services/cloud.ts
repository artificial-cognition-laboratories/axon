import { AxonCloud, HttpError, PRODUCTION_API_BASE } from "@arcforge/cloud"
import type { AxonCloudClient, AuthSession, AuthUser, DeviceAuthorization } from "@arcforge/cloud"
import { err } from "@arcforge/err"
import type { StoreT } from "./store"
import type { ProfileRecord } from "./store/types"

type CloudOpts = {
    store: StoreT
    /**
     * Which build this is. Production is hermetic — it pins the backend so a
     * project-local .env in the caller's cwd cannot redirect an installed app
     * to staging, and refuses ambient AXON_* credentials. Source development
     * deliberately keeps both.
     *
     * Taken as the input rather than as resolved flags: the composition root
     * should say WHICH BUILD this is, not decide what that implies about
     * credentials — that is this leaf's own policy.
     */
    distribution: Distribution
}

export type Distribution = "production" | "development"

/**
 * What asking the backend about a credential told us.
 *
 * Deliberately not a boolean: "false" conflated "the server said no" with "we
 * could not reach the server", and those need opposite handling — one must
 * scrub the credential and force a login, the other must preserve it.
 */
export type ValidationResult = "valid" | "rejected" | "unreachable"

/** A 401 — the backend actively refused this credential, as opposed to an outage. */
function isRejection(error: unknown): boolean {
    return error instanceof HttpError && error.status === 401
}

/**
 * Did we fail to REACH the backend, as opposed to hearing something bad from it?
 *
 * Recognised POSITIVELY — only a known transport failure counts. The inverse
 * ("anything that isn't an HttpError") was tempting and wrong: a malformed
 * payload, a parse guard, a bug in our own code all throw plain Errors, and
 * calling those "unreachable" would tell the user to check their wifi while
 * the real fault went unreported. Anything unrecognised throws instead, which
 * is the loud failure a genuinely unexpected error deserves.
 *
 * `fetch` rejects with a TypeError whose `cause` carries the OS-level code on
 * DNS/connection failure; an abort surfaces as an AbortError. Those are the
 * only two ways the network itself fails here.
 */
const TRANSPORT_CODES = new Set([
    "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN",
    "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET",
])

function isUnreachable(error: unknown): boolean {
    if (error instanceof HttpError) return false // the server answered
    if (error instanceof Error && error.name === "AbortError") return true
    if (error instanceof TypeError) return true // fetch's own connection failure
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code
    return typeof code === "string" && TRANSPORT_CODES.has(code)
}

/**
 * What a distribution implies. The one place the difference is written down.
 *
 * Credential VALIDATION is deliberately not here. It used to be
 * (`validateCredentials: false` for development), which meant a source build
 * accepted any credential on disk without ever asking the backend — so a
 * revoked key read as authenticated, the TUI's auth gate opened, and the user
 * landed in an app that could not talk to anything. It also made the failure
 * impossible to reproduce locally, which is why it survived to a user report.
 *
 * A credential that does not work does not work in any build. Only the things
 * that are genuinely a property of the DISTRIBUTION belong in this table.
 */
const POLICY = {
    production: { baseUrl: PRODUCTION_API_BASE, environmentCredentials: false },
    development: { baseUrl: undefined, environmentCredentials: true },
} as const satisfies Record<Distribution, {
    baseUrl: string | undefined
    environmentCredentials: boolean
}>

/**
 * TEMP: hardcoded until a real per-user setting exists. When true, logout()
 * deactivates the profile but keeps its token on disk — clicking the
 * profile again can silently refresh/reuse it instead of forcing a full
 * device-flow login. 2026-07-08.
 */
const REMEMBER_ME = true

type LoginInput = {
    /** Shown the verification step (URL + user code) — TUI renders a panel, CLI prints a line. */
    /** Show the user their code. May be async — awaited before polling begins, so a caller that approves inline is picked up on the first poll. */
    onCode: (authorization: DeviceAuthorization) => void | Promise<void>
    /** Login hint (email) forwarded to the backend. */
    hint?: string
    signal?: AbortSignal
}

/**
 * Cloud — a real AxonCloud client for the process lifetime, plus the disk
 * wiring AxonCloud itself doesn't own: which profile is active under
 * ~/.axon, and provider (BYOK) credentials.
 *
 * No rebuild, no identity swap at this layer — login/logout/refresh
 * already mutate the client's session in place (AxonCloud's own
 * contract). `client` is the real client, exposed directly; consumers use
 * it exactly as they would any other AxonCloud() instance.
 *
 * Switching to a different on-disk profile is disk-only here — it
 * changes which profile is "active" for the next Cloud() construction,
 * but does not change what the live `client` is authenticated as.
 * Adopting another profile's session into a live client is AxonCloud's
 * concern, not this wrapper's, until it exposes a way to do so.
 */
export function Cloud(opts: CloudOpts) {
    const store = opts.store
    const policy = POLICY[opts.distribution]

    /**
     * Subscribers to "the session just died mid-use".
     *
     * A set rather than a single callback: the TUI re-gates its UI, and other
     * surfaces may want to react too. Nothing here decides WHAT happens — this
     * layer only knows the credential stopped working.
     */
    const expiredListeners = new Set<() => void>()

    function build(): AxonCloudClient {
        const profile = store.profiles.current()
        const session = profile ? sessionFrom(profile.record) : null

        return AxonCloud({
            ...(policy.baseUrl ? { baseUrl: policy.baseUrl } : {}),
            ...(profile?.record.auth.apiKey ? { key: profile.record.auth.apiKey } : {}),
            ...(session ? { session } : {}),
            environmentCredentials: policy.environmentCredentials,
            onUnauthorized: () => { void onSessionExpired() },
        })
    }

    const client = build()

    /**
     * Any authenticated request came back 401 — the credential died while the
     * app was running.
     *
     * Scrubs it and tells subscribers, so the UI can re-gate immediately
     * instead of leaving the user in an app where nothing works until they
     * restart. Idempotent by construction: a burst of concurrent requests all
     * 401 at once, and invalidate() on an already-scrubbed profile is a no-op,
     * so listeners see at most one meaningful transition.
     */
    async function onSessionExpired(): Promise<void> {
        const profile = store.profiles.current()
        if (!profile) return // already scrubbed by whichever 401 got here first

        await invalidate(profile.id)
        for (const listener of expiredListeners) {
            try {
                listener()
            } catch {
                // One subscriber's fault must not stop the others being told
                // their session is gone.
            }
        }
    }

    async function invalidate(profileId: string): Promise<void> {
        const record = store.profiles.get(profileId).record.get()
        if (record) store.profiles.get(profileId).record.set({ ...record, auth: {} })
        if (store.profiles.active()?.id === profileId) store.profiles.deactivate()
        await client.user.auth.logout()
    }

    /**
     * Is the active profile's credential actually usable?
     *
     * Three outcomes, because they demand three different responses and
     * collapsing them is what let an unusable credential through the TUI's
     * auth gate:
     *
     *   valid       — the backend confirmed it. Proceed.
     *   rejected    — the backend refused it (401). The credential is scrubbed
     *                 here; the caller must send the user through login.
     *   unreachable — we could not ask. The credential may be perfectly good,
     *                 so it is NEVER destroyed — but it is equally not
     *                 verified, and entering the app on an unverified
     *                 credential is precisely the leak. The caller decides
     *                 (the TUI offers a retry).
     *
     * Self-healing comes first: a merely STALE token is refreshed and
     * re-checked before anything is called rejected, so an idle session comes
     * back on its own rather than demanding a device flow the user does not
     * need.
     */
    async function validateActive(): Promise<ValidationResult> {
        const profile = store.profiles.current()
        if (!profile) return "rejected"

        // Stale but refreshable is the common case for a session that has sat
        // idle. Try to heal it before asking the backend to judge it.
        if (client.user.auth.stale) {
            try {
                persist(await client.user.auth.refresh())
            } catch (error) {
                // A refusal to refresh IS a rejection — the credential is
                // spent. Anything else (offline) leaves it alone; me() below
                // will report unreachable on the same outage.
                if (isRejection(error)) {
                    await invalidate(profile.id)
                    return "rejected"
                }
            }
        }

        try {
            const user = await client.user.auth.me()
            const current = store.profiles.get(profile.id).record.get()
            if (current) {
                store.profiles.get(profile.id).record.set({
                    ...current,
                    user: {
                        id: user.id,
                        email: user.email,
                        name: user.name,
                        memberSince: new Date(user.memberSince).toISOString(),
                    },
                })
            }
            return "valid"
        } catch (error) {
            if (isRejection(error)) {
                await invalidate(profile.id)
                return "rejected"
            }
            // Only a TRANSPORT failure is "unreachable". A malformed response
            // or a 500 means we DID reach the backend and something is broken
            // — reporting that as an outage would tell the user to check their
            // connection while the real fault goes unseen. It throws.
            if (!isUnreachable(error)) throw error
            // Never scrubbed on an outage: a working credential must survive a
            // flaky network, and the honest answer is "we do not know yet".
            return "unreachable"
        }
    }

    /** Persist a live session as the active profile — merges over any existing record (keeps apiKey). */
    function persist(session: AuthSession): void {
        const existing = store.profiles.get(session.user.email).record.get()
        store.profiles.save(session.user.email, {
            ...existing,
            user: {
                id: session.user.id,
                email: session.user.email,
                name: session.user.name,
                memberSince: new Date(session.user.memberSince).toISOString(),
            },
            auth: {
                ...existing?.auth,
                accessToken: session.accessToken,
                expiresAt: session.expiresAt,
            },
        })
    }

    return {
        /** The real AxonCloud client — no proxying, no swap. */
        client: client,

        /**
         * A credential EXISTS on disk for the active profile.
         *
         * Not "the user is logged in" — this cannot tell a live session from a
         * revoked key, because it never leaves the disk. Anything gating
         * access (the TUI's auth route, a CLI command that needs a backend)
         * must use validate() and wait for the answer; treating this as the
         * gate is what let a dead credential into the app.
         */
        get authenticated(): boolean {
            const profile = store.profiles.current()
            return !!(profile?.record.auth.accessToken || profile?.record.auth.apiKey)
        },

        /**
         * Ask the backend whether the stored credential actually works,
         * refreshing a stale one first. Scrubs it on a 401. See
         * ValidationResult — an outage is NOT a rejection.
         */
        validate: validateActive,

        /**
         * Called when the credential dies MID-SESSION — any authenticated
         * request 401s after boot already passed its check.
         *
         * The credential is scrubbed before subscribers run, so a listener
         * re-reading `authenticated` sees the truth. Returns an unsubscribe.
         */
        onSessionExpired(listener: () => void): () => void {
            expiredListeners.add(listener)
            return () => expiredListeners.delete(listener)
        },

        /**
         * Device-flow login: the package runs the wire and mutates the
         * client's session in place; this persists the approved session
         * as the active profile.
         */
        async login(input: LoginInput): Promise<AuthUser> {
            const session = await client.user.auth.login({
                onVerification: input.onCode,
                ...(input.hint !== undefined ? { hint: input.hint } : {}),
                ...(input.signal !== undefined ? { signal: input.signal } : {}),
            })
            persist(session)
            return session.user
        },

        /** Exchange a stale token for a fresh one and re-persist it. Call when `client.user.auth.stale`. */
        async refresh(): Promise<void> {
            const session = await client.user.auth.refresh()
            persist(session)
        },

        /**
         * Deactivate the profile. With REMEMBER_ME, the token stays on disk
         * — switch() can silently refresh/reuse it later instead of forcing
         * a full device-flow login. Without it, auth is wiped immediately.
         */
        async logout(): Promise<void> {
            await client.user.auth.logout()

            const profile = store.profiles.current()
            if (profile) {
                if (!REMEMBER_ME) {
                    const scrubbed: ProfileRecord = { ...profile.record, auth: {} }
                    store.profiles.get(profile.id).record.set(scrubbed)
                }
                store.profiles.deactivate()
            }
        },

        /**
         * Change which on-disk profile is active AND adopt its session into
         * the live `client` — same client reference throughout, real
         * identity swap, no rebuild. If the stored token has since expired,
         * adopts it anyway and tries one refresh before giving up — the
         * common case for a REMEMBER_ME profile that's been idle a while.
         * Throws if the target profile has no adoptable session at all
         * (never logged in), or the refresh attempt also fails (revoked —
         * caller should fall back to a full login).
         */
        async switch(profileId: string): Promise<void> {
            const record = store.profiles.get(profileId).record.get()
            if (!record) {
                throw err("PROFILE_UNKNOWN", {
                    detail: `unknown profile: ${profileId} (known: ${store.profiles.list().join(", ") || "none"})`,
                    context: { profileId },
                })
            }

            const session = sessionFrom(record)
            if (!session) {
                throw err("PROFILE_NOT_AUTHENTICATED", { context: { profileId } })
            }

            store.profiles.activate(profileId)
            client.user.auth.adopt(session)

            // validateActive() owns the whole ladder now — refresh a stale
            // token, then verify — so this no longer refreshes by hand. Two
            // copies of that sequence was how they drifted: this one refreshed
            // without persisting the check, and treated an outage as a dead
            // profile.
            const result = await validateActive()
            if (result === "rejected") {
                throw err("PROFILE_NOT_AUTHENTICATED", { context: { profileId } })
            }
            if (result === "unreachable") {
                throw err("BACKEND_UNREACHABLE", {
                    detail: "could not reach the backend to verify this profile — check your connection and try again",
                    context: { profileId },
                })
            }
        },

        /**
         * Provider connections — account-level BYOK credentials held by
         * the backend vault. The client runs the interactive flow (OAuth
         * or key paste) and uploads the credential; nothing is persisted
         * on this machine. Pure delegation to AxonCloud's vault surface.
         */
        connections: {
            openai: client.user.vault.connections.openai,
            openrouter: client.user.vault.connections.openrouter,
        },
    }
}

export type CloudT = ReturnType<typeof Cloud>

/** A persisted record → an adoptable session. Null when no complete session was stored. */
function sessionFrom(record: ProfileRecord): AuthSession | null {
    if (!record.auth.accessToken || record.auth.expiresAt === undefined) return null
    return {
        accessToken: record.auth.accessToken,
        expiresAt: record.auth.expiresAt,
        user: {
            id: record.user.id,
            email: record.user.email,
            name: record.user.name ?? record.user.email,
            isStaff: false, // not persisted — me() refreshes identity after boot
            memberSince: record.user.memberSince ? Date.parse(record.user.memberSince) : 0,
        },
    }
}
