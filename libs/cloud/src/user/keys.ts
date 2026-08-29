import type { HttpClient } from "../platform/http"
import { bool, record, rows, str, strOrNull } from "../platform/parse"

type KeysOpts = {
    http: HttpClient
}

/**
 * Mirrors apps/backend/platform/auth/scopes.ts — the grantable vocabulary for
 * axon_... keys.
 *
 * A hand-maintained duplicate of a backend constant, which is exactly the kind
 * that drifts: this list sat at 11 entries while the backend moved to 19 when
 * cognets and benches became registry artifacts, and the device-flow test —
 * which asserts a session's granted scopes against THIS copy — failed for a
 * week because of it. When the backend list changes, change this one.
 */
export const API_KEY_SCOPES = [
    "agents:read",
    "agents:deploy",
    "agents:connect",
    "agents:delete",
    "modules:read",
    "modules:publish",
    "modules:delete",
    "cognets:read",
    "cognets:publish",
    "cognets:delete",
    "benches:read",
    "benches:publish",
    "prompts:read",
    "prompts:publish",
    "prompts:delete",
    "extensions:read",
    "extensions:publish",
    "extensions:delete",
    "benches:delete",
    "orgs:read",
    "orgs:manage",
    "billing:read",
    "billing:manage",
    "keys:manage",
    "vault:read",
    "vault:manage",
    // Runtime capabilities — what a deployed agent needs to do its job.
    "engine:invoke",
    "events:ingest",
] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

/** Plain-English consequence of each grant — shown wherever a scope is displayed. */
export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
    "agents:read": "see your agents and their deployments",
    "agents:deploy": "push new versions to your fleet",
    "agents:connect": "open live connections to running agents",
    "agents:delete": "remove agents and tear down their deployments",
    "modules:read": "see your modules, including private ones",
    "modules:publish": "publish module versions under your namespace",
    "modules:delete": "remove modules from the registry",
    "cognets:read": "see your cognets, including private ones",
    "cognets:publish": "publish cognet versions under your namespace",
    "cognets:delete": "remove cognets from the registry",
    "benches:read": "see your benchmarks, including private ones",
    "benches:publish": "publish benchmark versions under your namespace",
    "prompts:read": "read prompts you can access",
    "prompts:publish": "publish prompt versions under your namespace",
    "prompts:delete": "delete prompts you own",
    "extensions:read": "read TUI extensions you can access",
    "extensions:publish": "publish extension versions under your namespace",
    "extensions:delete": "delete extensions you own",
    "benches:delete": "remove benchmarks from the registry",
    "orgs:read": "see your organisations and their members",
    "orgs:manage": "invite, remove, and manage org members",
    "billing:read": "see balance, spend, and transactions",
    "billing:manage": "add payment methods, buy credit, and change commitments",
    "keys:manage": "create, rename, and revoke API keys",
    "vault:read": "list your stored secrets and mint provider tokens from your connections",
    "vault:manage": "add, replace, and remove stored secrets and provider connections",
    "engine:invoke": "run inference through Axon's managed models, billed to you",
    "events:ingest": "send telemetry from a running agent",
}

export type ApiKey = {
    id: string
    name: string
    type: string
    isActive: boolean
    scopes: ApiKeyScope[]
    lastUsedAt: string | null
    expiresAt: string | null
    createdAt: string
}

function parseKey(data: Record<string, unknown>): ApiKey {
    return {
        id: str(data, "id"),
        name: str(data, "name"),
        type: str(data, "type"),
        isActive: bool(data, "isActive"),
        scopes: (Array.isArray(data.scopes) ? data.scopes : []) as ApiKeyScope[],
        lastUsedAt: strOrNull(data, "lastUsedAt"),
        expiresAt: strOrNull(data, "expiresAt"),
        createdAt: str(data, "createdAt"),
    }
}

/**
 * API keys — the `axon_...` credentials for engine connections and ingest.
 * The plaintext key is returned exactly once, at creation; only metadata
 * is ever listable after that. Every key must carry an explicit scope
 * grant — an empty list authenticates but authorizes nothing.
 */
export function Keys(opts: KeysOpts) {
    return {
        async list(): Promise<ApiKey[]> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/keys")
            return rows(raw.keys, "keys").map(parseKey)
        },

        /** Create a key. `key` is the plaintext — shown once, never retrievable again. */
        async create(input: { name: string; scopes: ApiKeyScope[] }): Promise<ApiKey & { key: string }> {
            const raw = await opts.http.post<Record<string, unknown>>("/api/user/keys", { name: input.name, scopes: input.scopes })
            const created = record(raw, "created key")
            return { ...parseKey(created), key: str(created, "key") }
        },

        /** Rename — the only mutation a key supports; scopes change by rolling the key. */
        async rename(keyId: string, name: string): Promise<void> {
            await opts.http.patch(`/api/user/keys/${encodeURIComponent(keyId)}`, { name })
        },

        async revoke(keyId: string): Promise<void> {
            await opts.http.delete(`/api/user/keys/${encodeURIComponent(keyId)}`)
        },
    }
}

export type KeysHandle = ReturnType<typeof Keys>
