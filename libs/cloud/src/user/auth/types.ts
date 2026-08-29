/**
 * Auth domain types — shared by the orchestrator and its leaves.
 * Identity only: balance/currency live in user.billing, not here.
 */

export type AuthUser = {
    id: string
    email: string
    name: string
    isStaff: boolean
    /** unix ms */
    memberSince: number
}

/**
 * A live authenticated session — what login()/refresh() return and what
 * this layer holds in memory. Persistence across boots belongs to the
 * caller (TUI); it hands the token back via AxonCloud({ key }).
 */
export type AuthSession = {
    accessToken: string
    /** unix ms */
    expiresAt: number
    user: AuthUser
}

export type DeviceAuthorization = {
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete: string
    /** poll interval, seconds */
    interval: number
    /** authorization window, seconds */
    expiresIn: number
}

export type PollResult =
    | { status: "pending" }
    | { status: "expired" }
    | { status: "approved"; accessToken: string }

/**
 * Parse the backend's user shape ({ id, email, username, createdAt, isStaff })
 * into the canonical AuthUser. Throws on missing identity fields — username
 * is nullable backend-side (not every user has set one), so `name` falls
 * back to email in that case.
 */
export function parseAuthUser(raw: unknown): AuthUser {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("invalid user payload: not an object")
    }
    const data = raw as Record<string, unknown>

    if (typeof data.id !== "string" || data.id.length === 0) throw new Error("invalid user payload: missing id")
    if (typeof data.email !== "string" || data.email.length === 0) throw new Error("invalid user payload: missing email")

    const name = typeof data.username === "string" && data.username.length > 0 ? data.username : data.email
    const createdAt = typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN

    return {
        id: data.id,
        email: data.email,
        name,
        isStaff: data.isStaff === true,
        memberSince: Number.isFinite(createdAt) ? createdAt : Date.now(),
    }
}
