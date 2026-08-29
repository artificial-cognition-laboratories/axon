import { AxonCloud } from "../../src"
import type { AuthSession } from "../../src/user/auth/types"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()

const fakeSession: AuthSession = {
    accessToken: "session-token",
    expiresAt: Date.now() + 60_000,
    user: { id: "u1", email: "session@example.com", name: "Session User", isStaff: false, memberSince: Date.now() },
}

/** Snapshots and restores the two env vars the credential ladder reads — these tests must not leak state to each other or to other suites. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const keys = ["AXON_CONNECT_TOKEN", "AXON_API_KEY"] as const
    const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]))

    for (const k of keys) {
        if (vars[k] === undefined) delete process.env[k]
        else process.env[k] = vars[k]
    }

    try {
        fn()
    } finally {
        for (const k of keys) {
            if (prior[k] === undefined) delete process.env[k]
            else process.env[k] = prior[k]
        }
    }
}

describe("auth: credential ladder — token getter", () => {
    it("AXON_CONNECT_TOKEN env wins over everything else", () => {
        withEnv({ AXON_CONNECT_TOKEN: "connect-token", AXON_API_KEY: "env-api-key" }, () => {
            const cloud = AxonCloud({ baseUrl, key: "opts-key", session: fakeSession })
            expect(cloud.user.auth.token).toBe("connect-token")
        })
    })

    it("without AXON_CONNECT_TOKEN, a live session's accessToken wins next", () => {
        withEnv({ AXON_API_KEY: "env-api-key" }, () => {
            const cloud = AxonCloud({ baseUrl, key: "opts-key", session: fakeSession })
            expect(cloud.user.auth.token).toBe(fakeSession.accessToken)
        })
    })

    it("without a session, opts.key wins over the AXON_API_KEY env fallback", () => {
        withEnv({ AXON_API_KEY: "env-api-key" }, () => {
            const cloud = AxonCloud({ baseUrl, key: "opts-key" })
            expect(cloud.user.auth.token).toBe("opts-key")
        })
    })

    it("with nothing else set, falls back to the AXON_API_KEY env var", () => {
        withEnv({ AXON_API_KEY: "env-api-key" }, () => {
            const cloud = AxonCloud({ baseUrl })
            expect(cloud.user.auth.token).toBe("env-api-key")
        })
    })

    it("with no credential anywhere, token is undefined", () => {
        withEnv({}, () => {
            const cloud = AxonCloud({ baseUrl })
            expect(cloud.user.auth.token).toBeUndefined()
        })
    })

    it("can disable ambient credentials for an installed interactive app", () => {
        withEnv({ AXON_CONNECT_TOKEN: "stale-connect-token", AXON_API_KEY: "stale-api-key" }, () => {
            const cloud = AxonCloud({
                baseUrl,
                key: "persisted-key",
                session: fakeSession,
                environmentCredentials: false,
            })
            expect(cloud.user.auth.token).toBe(fakeSession.accessToken)
            expect(cloud.user.auth.apiKey).toBe("persisted-key")
        })
    })
})

describe("auth: credential ladder — apiKey getter", () => {
    it("opts.key wins over the AXON_API_KEY env var", () => {
        withEnv({ AXON_API_KEY: "env-api-key" }, () => {
            const cloud = AxonCloud({ baseUrl, key: "opts-key" })
            expect(cloud.user.auth.apiKey).toBe("opts-key")
        })
    })

    it("falls back to AXON_API_KEY when opts.key is absent", () => {
        withEnv({ AXON_API_KEY: "env-api-key" }, () => {
            const cloud = AxonCloud({ baseUrl })
            expect(cloud.user.auth.apiKey).toBe("env-api-key")
        })
    })

    it("is never influenced by a session's accessToken, unlike token", () => {
        withEnv({}, () => {
            const cloud = AxonCloud({ baseUrl, session: fakeSession })
            expect(cloud.user.auth.apiKey).toBeUndefined()
        })
    })

    it("is never influenced by AXON_CONNECT_TOKEN, unlike token", () => {
        withEnv({ AXON_CONNECT_TOKEN: "connect-token" }, () => {
            const cloud = AxonCloud({ baseUrl })
            expect(cloud.user.auth.apiKey).toBeUndefined()
        })
    })
})
